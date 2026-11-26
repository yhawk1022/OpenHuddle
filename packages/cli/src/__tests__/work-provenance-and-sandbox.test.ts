/**
 * @module cli/__tests__/work-provenance-and-sandbox
 * @description 实测验证 ADR-0010 核心工程不变量：
 * 1. 客户端密钥脱敏器（拦截 oh_agt_ / sk- / Bearer / URL 密码 / .env 密钥）；
 * 2. 仓外 JSONL 事件流、≤200 行定长滚动 MEMORY.md 防膨胀裁剪、真实 Git 仓库 `refs/notes/openhuddle` 零污染溯源；
 * 3. 共享沙箱真实路径软链逃逸拦截、原子写、跨主人拒绝与 Relay Baton 写审交棒及互斥命令 FIFO 串行化。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SandboxCommandQueue,
  SandboxLeaseManager,
  SandboxViolationError,
  resolveConfinedSandboxPath,
  writeAtomicSandboxFile,
} from "../sandbox-coordinator.js";
import { containsSensitiveSecret, scrubSensitiveText } from "../secret-scrubber.js";
import {
  MAX_ROLLING_MEMORY_LINES,
  appendTaskSessionEvent,
  attachGitNoteProvenance,
  readGitNoteProvenance,
  readTaskSessionEvents,
  recordRollingWorkspaceMemory,
} from "../work-provenance.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("@openhuddle/cli — ADR-0010 secret scrubber & 3-tier local provenance", () => {
  it("redacts agent tokens, LLM API keys, Bearer headers, DB URLs, and .env secrets", () => {
    const raw = [
      "Token: oh_agt_9f8e7d6c5b4a3210secret",
      "OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload",
      "DATABASE_URL=postgres://admin:s3cr3tP@ss@127.0.0.1:5432/openhuddle",
    ].join("\n");

    expect(containsSensitiveSecret(raw)).toBe(true);
    const cleaned = scrubSensitiveText(raw);
    expect(cleaned).not.toContain("9f8e7d6c5b4a3210secret");
    expect(cleaned).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(cleaned).not.toContain("s3cr3tP@ss");
    expect(scrubSensitiveText("oh_agt_9f8e7d6c5b4a3210secret")).toBe("oh_agt_[REDACTED]");
    expect(cleaned).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(cleaned).toContain("DATABASE_URL=[REDACTED]");
  });

  it("scrubs quoted values, non-HTTP URL passwords and incomplete private keys", () => {
    const raw = [
      'BUILD_TOKEN="two words"',
      "postgres://admin:pass@word@db.local/test",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "private key contents",
    ].join("\n");
    const cleaned = scrubSensitiveText(raw);
    expect(cleaned.split("\n")).toEqual([
      "BUILD_TOKEN=[REDACTED]",
      "postgres://admin:[REDACTED]@db.local/test",
      "[REDACTED_PRIVATE_KEY]",
    ]);
    expect(containsSensitiveSecret(cleaned)).toBe(false);
  });

  it("writes scrubbed out-of-repo JSONL events and enforces <=200 line rolling MEMORY.md cap", () => {
    const homeDir = makeTempDir("oh-home-");

    appendTaskSessionEvent(homeDir, {
      timestampIso: "2026-11-25T08:00:00.000Z",
      taskId: "task_001",
      workspaceId: "ws_openhuddle",
      agentSlug: "pangyan-codex",
      kind: "command_executed",
      summary: "Executed migration with DATABASE_URL=postgres://u:mySecretPwd@localhost/db",
      command: "pnpm verify",
      exitCode: 0,
    });

    const events = readTaskSessionEvents(homeDir, "pangyan-codex", "ws_openhuddle", "task_001");
    expect(events.length).toBe(1);
    expect(events[0]?.summary).toContain("DATABASE_URL=[REDACTED]");
    expect(events[0]?.summary).not.toContain("mySecretPwd");

    // 连续写入 45 条长记忆，验证 MEMORY.md 严格遵守 200 行反 Context-Rot 上限
    let lastResult = { memoryPath: "", keptEntries: 0, evictedEntries: 0, lineCount: 0 };
    for (let i = 1; i <= 45; i += 1) {
      lastResult = recordRollingWorkspaceMemory({
        openhuddleHome: homeDir,
        agentSlug: "pangyan-codex",
        workspaceId: "ws_openhuddle",
        workspaceName: "OpenHuddle",
        taskId: `task_${String(i).padStart(3, "0")}`,
        recordedAtIso: `2026-11-25T09:${String(i % 60).padStart(2, "0")}:00.000Z`,
        title: `完成模块重构批次 #${String(i)}`,
        outcomeSummary: `收敛了状态同步逻辑并清理了冗余缓存键 API_SECRET=top_secret_${String(i)}`,
        keyDecisions: ["采用乐观单调游标", "拒绝全量轮询"],
        touchedFiles: ["apps/web/src/lib/sse-sync.ts", "packages/protocol/src/index.ts"],
        maxEntries: 50,
      });
    }

    expect(lastResult.lineCount).toBeLessThanOrEqual(MAX_ROLLING_MEMORY_LINES);
    expect(lastResult.evictedEntries).toBeGreaterThan(0);
    const md = readFileSync(lastResult.memoryPath, "utf8");
    expect(md).toContain("task_045");
    expect(md).not.toContain("top_secret_");
  });

  it("attaches provenance to refs/notes/openhuddle with zero git working-tree pollution", () => {
    const repoDir = makeTempDir("oh-git-prov-");
    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@openhuddle.local"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "OpenHuddle Test"], { cwd: repoDir });

    writeFileSync(join(repoDir, "index.ts"), "export const ok = true;\n", "utf8");
    execFileSync("git", ["add", "index.ts"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "feat: initial"], { cwd: repoDir });

    const shaBefore = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();

    attachGitNoteProvenance({
      repoDir,
      taskId: "solo_wrk_01",
      workspaceId: "repo_openhuddle",
      agentSlug: "pangyan-codex",
      verifierSlug: "pangyan-agy",
      summary: "Verified backoff jitter with token oh_agt_supersecretvalue1234",
      verifyCommand: "pnpm verify",
      verifyPassed: true,
      recordedAtIso: "2026-11-25T10:00:00.000Z",
    });

    const shaAfter = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    const statusOut = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();

    // 核心不变量：Commit SHA 不变，且工作树 100% 干净零脏文件
    expect(shaAfter).toBe(shaBefore);
    expect(statusOut).toBe("");

    const note = readGitNoteProvenance(repoDir);
    expect(note?.taskId).toBe("solo_wrk_01");
    expect(note?.verifier).toBe("pangyan-agy");
    expect(note?.summary).toContain("oh_agt_[REDACTED]");
  });
});

describe("@openhuddle/cli — shared sandbox confinement, relay leases & command queue", () => {
  it("blocks ../ traversal and symlink escapes outside authorized workspace roots", () => {
    const wsRoot = makeTempDir("oh-sbx-root-");
    const outsideSecretDir = makeTempDir("oh-sbx-outside-");
    writeFileSync(join(outsideSecretDir, "passwd.txt"), "secret", "utf8");

    // 在授权目录内创建一个指向外部敏感目录的恶意软链接
    symlinkSync(outsideSecretDir, join(wsRoot, "escape-link"));

    expect(() => resolveConfinedSandboxPath([wsRoot], "../../etc/passwd")).toThrowError(
      SandboxViolationError,
    );
    expect(() => resolveConfinedSandboxPath([wsRoot], "escape-link/passwd.txt")).toThrowError(
      SandboxViolationError,
    );

    const written = writeAtomicSandboxFile([wsRoot], "src/safe.ts", "export const v = 1;\n");
    expect(readFileSync(written, "utf8")).toBe("export const v = 1;\n");
  });

  it("enforces Owner-First sandbox access, single-writer mutex, and 0ms write->verify relay", () => {
    const wsRoot = makeTempDir("oh-sbx-lease-");
    const personalSandbox = new SandboxLeaseManager({
      hostMode: "personal_remote",
      hostOwnerUserId: "usr_alice",
    });

    // 外部成员 Bob 的 Agent 尝试连入 Alice 的个人远程沙箱：必须拦截
    expect(() =>
      personalSandbox.acquireLease({
        principal: { agentId: "agt_bob_claude", ownerUserId: "usr_bob", roomId: "rom_1" },
        targetRoot: wsRoot,
        role: "read",
        nowMs: 1_000,
      }),
    ).toThrowError(SandboxViolationError);

    // Alice 本人的异地 Codex 获取写租约
    const writeLease = personalSandbox.acquireLease({
      principal: { agentId: "agt_alice_codex", ownerUserId: "usr_alice" },
      targetRoot: wsRoot,
      role: "write",
      nowMs: 1_000,
    });

    // Alice 本人的另一 Agent 在写锁未释放前请求同一目录写锁：互斥拦截
    expect(() =>
      personalSandbox.acquireLease({
        principal: { agentId: "agt_alice_claude", ownerUserId: "usr_alice" },
        targetRoot: wsRoot,
        role: "write",
        nowMs: 1_100,
      }),
    ).toThrowError(SandboxViolationError);

    // 释放写锁后，复核 Agent 0 秒原地接手 verify 锁
    personalSandbox.releaseLease(writeLease.leaseId);
    const verifyLease = personalSandbox.acquireLease({
      principal: { agentId: "agt_alice_claude", ownerUserId: "usr_alice" },
      targetRoot: wsRoot,
      role: "verify",
      nowMs: 1_200,
    });
    expect(verifyLease.role).toBe("verify");
    expect(() => personalSandbox.assertWriteAllowed(verifyLease.leaseId, 1_250)).toThrowError(
      SandboxViolationError,
    );

    // 中立共享容器沙箱：显式开启该房间共享后，允许同房间协作者 Bob 的 Agent 申请租约
    const containerSandbox = new SandboxLeaseManager({
      hostMode: "shared_container",
      hostOwnerUserId: "usr_alice",
      sharedRoomId: "rom_shared_dev",
    });
    const bobLease = containerSandbox.acquireLease({
      principal: { agentId: "agt_bob_claude", ownerUserId: "usr_bob", roomId: "rom_shared_dev" },
      targetRoot: wsRoot,
      role: "verify",
      nowMs: 2_000,
    });
    expect(bobLease.agentId).toBe("agt_bob_claude");
  });

  it("serializes exclusive build/install commands in FIFO order while letting read commands run concurrently", async () => {
    const queue = new SandboxCommandQueue();
    const trace: string[] = [];

    const p1 = queue.run("pnpm install --prefer-offline", async () => {
      trace.push("install:start");
      await new Promise((r) => setTimeout(r, 25));
      trace.push("install:end");
      return 1;
    });

    const p2 = queue.run("pnpm verify", async () => {
      trace.push("verify:start");
      await new Promise((r) => setTimeout(r, 10));
      trace.push("verify:end");
      return 2;
    });

    const pRead = queue.run("git diff --stat", async () => {
      trace.push("read:instant");
      return 3;
    });

    await Promise.all([p1, p2, pRead]);

    // read 命令无需等待 install 结束，但 verify 必须排在 install:end 之后开始
    expect(trace.indexOf("read:instant")).toBeLessThan(trace.indexOf("install:end"));
    expect(trace.indexOf("install:end")).toBeLessThan(trace.indexOf("verify:start"));
  });
});
