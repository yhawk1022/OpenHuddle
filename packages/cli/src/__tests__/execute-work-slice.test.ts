import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeviceWorkInput,
  executeWorkSlice,
  isTransientExecutionError,
} from "../execute-work-slice.js";
import { OpenHuddleApiError } from "../http-client.js";
import { extractTextEditPayload } from "../work-text-edits.js";

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
    task.slice = { ...task.slice, leaseRole: "read" };
    setRoot(task, "~/missing");
    await expect(executeWorkSlice(task)).rejects.toThrow("此设备上找不到");
    task.slice = { ...task.slice, leaseRole: "write" };
    await symlink(tmpdir(), path.join(repo, "outside"));
    setRoot(task, "~/projects/project/outside");
    await expect(executeWorkSlice(task)).rejects.toThrow("当前用户目录");
  });
  it("creates a missing project folder on the first write, initializing Git only for worktree isolation", async () => {
    await installCli(
      "dsh",
      `
      const fs = require("node:fs");
      fs.readFileSync(0, "utf8");
      if (process.env.DSH_PERMISSION_MODE !== "workspace-write") process.exit(2);
      fs.writeFileSync("index.js", "exports.created = true;\\n");
      console.log("Created index.js");
    `,
    );
    const plainTask = assignment();
    plainTask.workspace.sandboxMode = "in_place";
    plainTask.agent.platform = "deepseek";
    setRoot(plainTask, "~/projects/fresh");
    const plainResult = await executeWorkSlice(plainTask);
    expect(plainResult.changedFiles).toEqual(["index.js"]);
    expect(await readFile(path.join(homeDir, "projects", "fresh", "index.js"), "utf8")).toContain(
      "created = true",
    );

    await installCli(
      "codex",
      `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      if (!args.includes("workspace-write") || !fs.readFileSync(0, "utf8").includes("Create an index")) process.exit(9);
      fs.writeFileSync("打砖块.html", "<p>from worker</p>\\n");
      fs.writeFileSync(args[args.indexOf("-o") + 1], "Created 打砖块.html");
    `,
    );
    const pooledTask = assignment();
    setRoot(pooledTask, "~/projects/新项目");
    const pooledResult = await executeWorkSlice(pooledTask);
    expect(pooledResult.changedFiles).toEqual(["打砖块.html"]);
    const newGitRoot = path.join(homeDir, "projects", "新项目");
    expect(
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: newGitRoot,
        encoding: "utf8",
      }).trim(),
    ).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(path.join(newGitRoot, "打砖块.html"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const blockedTask = assignment();
    setRoot(blockedTask, "~/.hidden/new");
    await expect(executeWorkSlice(blockedTask)).rejects.toThrow("当前用户目录");
    await expect(stat(path.join(homeDir, ".hidden"))).rejects.toMatchObject({ code: "ENOENT" });
    setRoot(blockedTask, "~/Library/new");
    await expect(executeWorkSlice(blockedTask)).rejects.toThrow("当前用户目录");
    await expect(stat(path.join(homeDir, "Library"))).rejects.toMatchObject({ code: "ENOENT" });

    setRoot(blockedTask, "~/dOcUmEnTs");
    await expect(executeWorkSlice(blockedTask)).rejects.toThrow("当前用户目录");
    const broken = path.join(homeDir, "projects", "broken");
    await symlink(path.join(homeDir, "missing"), broken);
    setRoot(blockedTask, "~/projects/broken/nested");
    await expect(executeWorkSlice(blockedTask)).rejects.toThrow("broken symbolic link");

    const restrictedInPlace = assignment();
    restrictedInPlace.workspace.sandboxMode = "in_place";
    restrictedInPlace.slice = { ...restrictedInPlace.slice, ownedPaths: ["packages/**"] };
    setRoot(restrictedInPlace, "~/projects/should-not-create");
    await expect(executeWorkSlice(restrictedInPlace)).rejects.toThrow("原地目录");
    await expect(stat(path.join(homeDir, "projects", "should-not-create"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const badBranchPooled = assignment();
    badBranchPooled.workspace.roots = [
      {
        id: "root",
        name: "project",
        localPath: "~/projects/bad-branch",
        defaultBranch: "main..bad",
      },
    ];
    expect((await executeWorkSlice(badBranchPooled)).changedFiles).toEqual(["打砖块.html"]);
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
  it("validates all proposed edits before changing any file and does not retry security rejections", async () => {
    const task = assignment();
    task.workspace.sandboxMode = "in_place";
    task.runner = { kind: "preset", preset: "gemini" };
    await writeFile(path.join(repo, "keep.txt"), "unchanged");
    const counterFile = path.join(homeDir, "gemini-security-count.txt");
    await installCli(
      "gemini",
      `
      const fs = require("node:fs");
      const count = fs.existsSync(${JSON.stringify(counterFile)}) ? Number(fs.readFileSync(${JSON.stringify(counterFile)}, "utf8")) : 0;
      fs.writeFileSync(${JSON.stringify(counterFile)}, String(count + 1));
      console.log(JSON.stringify({summary:"edit",files:[{path:"keep.txt",content:"changed"},{path:".git/config",content:"forbidden"}]}));
      `,
    );
    await expect(executeWorkSlice(task)).rejects.toThrow("无效的文件变更");
    expect(await readFile(path.join(repo, "keep.txt"), "utf8")).toBe("unchanged");
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  it("heals a clean unborn HEAD preserving its original branch and rejects a dirty unborn HEAD", async () => {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/develop"], { cwd: repo });
    await installCli(
      "codex",
      `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      fs.writeFileSync("healed.txt", "ok\\n");
      fs.writeFileSync(args[args.indexOf("-o") + 1], "Healed clean unborn repo");
      `,
    );
    const cleanTask = assignment();
    cleanTask.workspace.roots = [
      { id: "root", name: "project", localPath: "~/projects/project", defaultBranch: "main" },
    ];
    const cleanResult = await executeWorkSlice(cleanTask);
    expect(cleanResult.changedFiles).toEqual(["healed.txt"]);
    expect(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim(),
    ).toBe("develop");

    const dirtyRepo = path.join(homeDir, "projects", "dirty-unborn");
    await mkdir(dirtyRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dirtyRepo });
    execFileSync("git", ["config", "status.showUntrackedFiles", "no"], { cwd: dirtyRepo });
    await writeFile(path.join(dirtyRepo, "untracked.txt"), "draft\n");
    const dirtyTask = assignment();
    setRoot(dirtyTask, "~/projects/dirty-unborn");
    await expect(executeWorkSlice(dirtyTask)).rejects.toThrow("未提交文件");
    expect(() =>
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: dirtyRepo, stdio: "ignore" }),
    ).toThrow();
  });

  it("keeps the parent repository intact when the workspace points to a missing subfolder", async () => {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const task = assignment();
    setRoot(task, "~/projects/project/child/deep");
    await expect(executeWorkSlice(task)).rejects.toThrow("已有 Git 仓库内");
    await expect(stat(path.join(repo, "child"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.join(repo, ".git"))).isDirectory()).toBe(true);
  });

  it("removes only the newly created directory chain when Git initialization fails", async () => {
    const task = assignment();
    setRoot(task, "~/projects/first-attempt/deep");
    vi.stubEnv("GIT_AUTHOR_DATE", "invalid date format");
    await expect(executeWorkSlice(task)).rejects.toThrow(/date format/);
    await expect(stat(path.join(homeDir, "projects", "first-attempt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(path.join(homeDir, "projects"))).isDirectory()).toBe(true);
  });

  it("serializes first writes to a missing repository and ignores inherited Git paths", async () => {
    await installCli(
      "codex",
      `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      fs.writeFileSync("result.txt", "done");
      fs.writeFileSync(args[args.indexOf("-o") + 1], "Created result.txt");
    `,
    );
    vi.stubEnv("GIT_DIR", path.join(repo, "other-git"));
    const first = assignment();
    const second = assignment();
    second.item = { ...second.item, worktreeBranch: "oh/test-two" };
    for (const task of [first, second]) setRoot(task, "~/projects/new/shared");
    const results = await Promise.all([executeWorkSlice(first), executeWorkSlice(second)]);
    expect(results.map((r) => r.changedFiles)).toEqual([["result.txt"], ["result.txt"]]);
    await expect(stat(path.join(repo, "other-git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans an empty leftover worktree dir, fails closed on non-empty/symlink conflicts, and reuses existing branches without -B", async () => {
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
      fs.writeFileSync("output.txt", "work\\n");
      fs.writeFileSync(args[args.indexOf("-o") + 1], "Updated output.txt");
      `,
    );

    const rootReal = await realpath(repo);
    const parent = path.join(homeDir, ".openhuddle", "worktrees", "device");
    await mkdir(parent, { recursive: true });
    const destFor = (branch: string) =>
      path.join(
        parent,
        createHash("sha256")
          .update([rootReal, "wsp_test", "wrk_task", branch].join("\0"))
          .digest("hex")
          .slice(0, 32),
      );

    // 1. Empty leftover dir is removed via rmdir and recreated cleanly
    const emptyLeftover = destFor("oh/empty-shell");
    await mkdir(emptyLeftover, { recursive: true });
    const emptyTask = assignment();
    emptyTask.item.worktreeBranch = "oh/empty-shell";
    expect((await executeWorkSlice(emptyTask)).changedFiles).toEqual(["output.txt"]);

    // 2. Non-empty leftover dir fails closed without deleting user data
    const dirtyLeftover = destFor("oh/dirty-shell");
    await mkdir(dirtyLeftover, { recursive: true });
    await writeFile(path.join(dirtyLeftover, "keep.txt"), "do-not-delete");
    const dirtyTask = assignment();
    dirtyTask.item.worktreeBranch = "oh/dirty-shell";
    await expect(executeWorkSlice(dirtyTask)).rejects.toThrow("已有工作树与工单分支不一致");
    expect(await readFile(path.join(dirtyLeftover, "keep.txt"), "utf8")).toBe("do-not-delete");

    // 3. Symlink at dest fails closed
    const linkTarget = path.join(homeDir, "link-target");
    await mkdir(linkTarget, { recursive: true });
    const symlinkDest = destFor("oh/symlink-shell");
    await symlink(linkTarget, symlinkDest);
    const linkTask = assignment();
    linkTask.item.worktreeBranch = "oh/symlink-shell";
    await expect(executeWorkSlice(linkTask)).rejects.toThrow("已有工作树与工单分支不一致");

    // 4. Existing branch (with a prior commit after worktree removal) is reused without -B reset
    execFileSync("git", ["checkout", "-qb", "oh/reused"], { cwd: repo });
    await writeFile(path.join(repo, "prior.txt"), "from-prior-commit\n");
    execFileSync("git", ["add", "prior.txt"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "prior"],
      { cwd: repo },
    );
    const priorSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "-q", "-"], { cwd: repo });

    const reuseTask = assignment();
    reuseTask.item.worktreeBranch = "oh/reused";
    const reused = await executeWorkSlice(reuseTask);
    expect(reused.changedFiles).toEqual(["output.txt"]);
    const wtDir = reused.provenance?.workingDirectory ?? "";
    expect(await readFile(path.join(wtDir, "prior.txt"), "utf8")).toBe("from-prior-commit\n");
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: wtDir, encoding: "utf8" }).trim(),
    ).toBe(priorSha);
  });

  it("extracts wrapped JSON payloads cleanly and performs at most 1 scrubbed format-repair retry in file broker mode", async () => {
    // Direct extraction test covering CRLF fences, nested markdown fences inside content, and multi-object selection
    const trickyReply = [
      'Preliminary note: {"meta": "ignored"}',
      "```json\r\nnot-valid-json\r\n```",
      `Final payload: ${JSON.stringify({
        summary: "Updated README",
        files: [
          {
            path: "README.md",
            content: '# Demo\n```ts\nconst x = "{braces}";\n```\n',
          },
        ],
      })}`,
      "Done!",
    ].join("\r\n");
    const extracted = extractTextEditPayload(trickyReply);
    expect(extracted).toMatchObject({
      summary: "Updated README",
      files: [{ path: "README.md" }],
    });

    const payload = { summary: "write", files: [{ path: "a.txt", content: "ok" }] };
    const json = JSON.stringify(payload);
    expect(extractTextEditPayload(["```json", '{"meta":true}', "```", json].join("\n"))).toEqual(
      payload,
    );
    expect(extractTextEditPayload(`Incomplete { note. Actual edits: ${json}`)).toEqual(payload);

    // End-to-end 1-time repair retry with secret scrubbing and <=600-char excerpt
    const task = assignment();
    task.workspace.sandboxMode = "in_place";
    task.runner = { kind: "preset", preset: "claude_code" };
    const callsFile = path.join(homeDir, "claude-calls.json");
    await installCli(
      "claude",
      `
      const fs = require("node:fs");
      const prompt = fs.readFileSync(0, "utf8");
      const calls = fs.existsSync(${JSON.stringify(callsFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(callsFile)}, "utf8")) : [];
      calls.push(prompt);
      fs.writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
      if (calls.length === 1) {
        console.log("Not valid json with token oh_agt_secretToken123456 " + "x".repeat(900));
      } else {
        console.log("Here is the fix:\\r\\n" + JSON.stringify({summary:"Fixed via retry",files:[{path:"repaired.txt",content:"fixed\\n"}]}));
      }
      `,
    );
    const written = await executeWorkSlice(task);
    expect(written.changedFiles).toEqual(["repaired.txt"]);
    expect(written.summary).toBe("Fixed via retry");
    const prompts = JSON.parse(await readFile(callsFile, "utf8")) as string[];
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain("secretToken123456");
    expect(prompts[1]).toContain("oh_agt_[REDACTED]");
    const excerptIdx = prompts[1]?.indexOf("Previous response (sanitized excerpt):\n") ?? -1;
    expect(excerptIdx).toBeGreaterThan(-1);
    const excerpt = (prompts[1] ?? "").slice(
      excerptIdx + "Previous response (sanitized excerpt):\n".length,
    );
    expect(excerpt.length).toBeLessThanOrEqual(600);
  });

  it("accepts Markdown VERDICT, performs 1-time missing-verdict completion reusing turn-1 summary, and reminds empty native writes once", async () => {
    const task = assignment();
    task.workspace.sandboxMode = "in_place";
    task.agent.platform = "deepseek";

    // 1. Native write empty-diff reminder succeeds on 2nd turn while preserving before snapshot
    await writeFile(path.join(repo, "existing.txt"), "base\n");
    const writeCountFile = path.join(homeDir, "dsh-write-count.txt");
    await installCli(
      "dsh",
      `
      const fs = require("node:fs");
      const prompt = fs.readFileSync(0, "utf8");
      const count = fs.existsSync(${JSON.stringify(writeCountFile)}) ? Number(fs.readFileSync(${JSON.stringify(writeCountFile)}, "utf8")) : 0;
      fs.writeFileSync(${JSON.stringify(writeCountFile)}, String(count + 1));
      if (count === 0) {
        console.log("I recommend adding hello.txt.");
      } else {
        if (!prompt.includes("No file changes were detected")) process.exit(5);
        fs.writeFileSync("hello.txt", "world\\n");
        console.log("Created hello.txt on reminder.");
      }
      `,
    );
    const written = await executeWorkSlice(task);
    expect(written.changedFiles).toEqual(["hello.txt"]);
    expect(await readFile(writeCountFile, "utf8")).toBe("2");

    // 2. Verify with Markdown VERDICT passes in 1 call
    task.item.slices = [
      {
        ...task.slice,
        status: "ready",
        liveSummary: written.summary,
        changedFiles: written.changedFiles,
      },
    ];
    task.item.diffFiles = written.diffFiles ?? [];
    task.slice = { ...task.slice, leaseRole: "verify" };
    await installCli("dsh", 'console.log("Static review complete.\\n### **VERDICT：PASSED。**");');
    expect(await executeWorkSlice(task)).toMatchObject({
      verdict: "passed",
      summary: "Static review complete.",
    });

    // 3. Verify missing verdict triggers 1 follow-up; VERDICT-only 2nd turn reuses sanitized turn-1 draft
    const verifyCountFile = path.join(homeDir, "dsh-verify-count.txt");
    await installCli(
      "dsh",
      `
      const fs = require("node:fs");
      const prompt = fs.readFileSync(0, "utf8");
      const count = fs.existsSync(${JSON.stringify(verifyCountFile)}) ? Number(fs.readFileSync(${JSON.stringify(verifyCountFile)}, "utf8")) : 0;
      fs.writeFileSync(${JSON.stringify(verifyCountFile)}, String(count + 1));
      if (count === 0) {
        console.log("Checked hello.txt carefully with token oh_agt_leak1234567890.");
      } else {
        if (prompt.includes("leak1234567890")) process.exit(6);
        console.log("VERDICT: PASSED");
      }
      `,
    );
    const verified = await executeWorkSlice(task);
    expect(verified.verdict).toBe("passed");
    expect(verified.summary).toContain("Checked hello.txt carefully");
    expect(verified.summary).not.toContain("leak1234567890");
    expect(await readFile(verifyCountFile, "utf8")).toBe("2");
  });

  it("retries transient 429/503 errors in-lease without losing before snapshot or rerunning LLM after saveReviewEvidence, and never retries auth/quota", async () => {
    expect(
      isTransientExecutionError(new Error("Agent CLI 退出（1）：429 rate limit exceeded")),
    ).toBe(true);
    expect(
      isTransientExecutionError(new Error("Agent CLI 退出（1）：429 insufficient_quota billing")),
    ).toBe(false);
    expect(isTransientExecutionError(new Error("Agent CLI 退出（1）：401 invalid_api_key"))).toBe(
      false,
    );
    expect(
      isTransientExecutionError(
        new OpenHuddleApiError({ status: 409, code: "WORK_LEASE_EXPIRED", message: "conflict" }),
      ),
    ).toBe(false);
    expect(
      isTransientExecutionError(
        new OpenHuddleApiError({ status: 503, code: "INTERNAL_ERROR", message: "unavailable" }),
      ),
    ).toBe(true);

    // 1. Transient 429 retries once and succeeds; saveReviewEvidence 503 retries ONLY saveReviewEvidence (not CLI)
    const task = assignment();
    task.workspace.sandboxMode = "in_place";
    task.agent.platform = "deepseek";
    task.retryDelayMs = 0;
    const cliCountFile = path.join(homeDir, "dsh-429-count.txt");
    await installCli(
      "dsh",
      `
      const fs = require("node:fs");
      const count = fs.existsSync(${JSON.stringify(cliCountFile)}) ? Number(fs.readFileSync(${JSON.stringify(cliCountFile)}, "utf8")) : 0;
      fs.writeFileSync(${JSON.stringify(cliCountFile)}, String(count + 1));
      if (count === 0) {
        console.error("HTTP 429 Too Many Requests: rate limit exceeded");
        process.exit(1);
      }
      fs.writeFileSync("recovered.txt", "after-429\\n");
      console.log("Recovered after 429");
      `,
    );
    const saveEvidence = vi
      .fn<(patch: string) => Promise<void>>()
      .mockRejectedValueOnce(
        new OpenHuddleApiError({ status: 503, code: "INTERNAL_ERROR", message: "gateway busy" }),
      )
      .mockResolvedValueOnce(undefined);
    task.saveReviewEvidence = saveEvidence;
    const res = await executeWorkSlice(task);
    expect(res.changedFiles).toEqual(["recovered.txt"]);
    expect(await readFile(cliCountFile, "utf8")).toBe("2");
    expect(saveEvidence).toHaveBeenCalledTimes(2);

    // 2. Non-transient 401 invalid_api_key has 0 retries
    const authCountFile = path.join(homeDir, "dsh-401-count.txt");
    await installCli(
      "dsh",
      `
      const fs = require("node:fs");
      const count = fs.existsSync(${JSON.stringify(authCountFile)}) ? Number(fs.readFileSync(${JSON.stringify(authCountFile)}, "utf8")) : 0;
      fs.writeFileSync(${JSON.stringify(authCountFile)}, String(count + 1));
      console.error("401 invalid_api_key");
      process.exit(1);
      `,
    );
    const authTask = assignment();
    authTask.workspace.sandboxMode = "in_place";
    authTask.agent.platform = "deepseek";
    authTask.retryDelayMs = 0;
    await expect(executeWorkSlice(authTask)).rejects.toThrow("401 invalid_api_key");
    expect(await readFile(authCountFile, "utf8")).toBe("1");

    // 3. saveReviewEvidence 409 is NOT retried
    const conflictTask = assignment();
    conflictTask.workspace.sandboxMode = "in_place";
    conflictTask.agent.platform = "deepseek";
    conflictTask.retryDelayMs = 0;
    await installCli(
      "dsh",
      `
      const fs = require("node:fs");
      fs.writeFileSync("conflict.txt", "data\\n");
      console.log("Wrote conflict.txt");
      `,
    );
    const saveConflict = vi
      .fn()
      .mockRejectedValue(
        new OpenHuddleApiError({ status: 409, code: "WORK_LEASE_EXPIRED", message: "stale lease" }),
      );
    conflictTask.saveReviewEvidence = saveConflict;
    await expect(executeWorkSlice(conflictTask)).rejects.toThrow("stale lease");
    expect(saveConflict).toHaveBeenCalledOnce();
  });
});
