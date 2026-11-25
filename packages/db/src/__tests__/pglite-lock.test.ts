import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCoreSchema } from "../bootstrap.js";
import { createDatabaseClient } from "../client.js";

describe("@openhuddle/db — file-backed PGlite host lock & crash recovery", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks concurrent host processes via .owner.pid and recovers stale postmaster.pid", async () => {
    const root = mkdtempSync(join(tmpdir(), "openhuddle-pglite-lock-"));
    tempRoots.push(root);
    const dataDir = join(root, "pglite");
    const lockPath = `${dataDir}.owner.pid`;

    // 1. 首次创建并写入核心 Schema，释放后 .owner.pid 必须被清理
    const first = createDatabaseClient({ url: `file://${dataDir}` });
    await ensureCoreSchema(first.db);
    expect(existsSync(lockPath)).toBe(true);
    await first.close();
    expect(existsSync(lockPath)).toBe(false);

    // 2. 模拟宿主机另一个存活进程（ppid）正持有同一数据目录：必须立即拒绝双写以保护 WAL
    if (process.ppid > 0 && process.ppid !== process.pid) {
      writeFileSync(lockPath, `${String(process.ppid)}\n`, "utf8");
      expect(() => createDatabaseClient({ url: `file://${dataDir}` })).toThrow(
        /already in use by active process PID/,
      );
    }

    // 3. 模拟进程被 SIGKILL 后遗留已死亡 PID 与陈旧 postmaster.pid：应自动摘除陈旧锁并正常恢复启动
    writeFileSync(lockPath, "99999999\n", "utf8");
    writeFileSync(join(dataDir, "postmaster.pid"), "1\n/tmp\n", "utf8");
    const recovered = createDatabaseClient({ url: `file://${dataDir}` });
    await ensureCoreSchema(recovered.db);
    expect(existsSync(lockPath)).toBe(true);
    await recovered.close();
    expect(existsSync(lockPath)).toBe(false);
  });
});
