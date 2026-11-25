import { execFile } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { capturePlainFolderSnapshot } from "@openhuddle/core-governance/workspace-diff";
import { containsSensitiveSecret } from "./secret-scrubber.js";
import type { WorkPromptInput } from "./work-cli-process.js";

const exec = promisify(execFile);

export function isOwnedFile(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "**" || pattern === "." || pattern === "**/*") return true;
    const clean = pattern.replace(/^\.\//, "");
    if (clean.endsWith("/**")) return relativePath.startsWith(clean.slice(0, -2));
    if (clean.endsWith("/*")) return path.posix.dirname(relativePath) === clean.slice(0, -2);
    return relativePath === clean;
  });
}

function safeProjectFile(file: string): boolean {
  return (
    file.length > 0 &&
    file.length <= 260 &&
    ![...file].some(
      (char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === ":" || char === "\\",
    ) &&
    file
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          !part.startsWith(".") &&
          !part.endsWith(".") &&
          !part.endsWith(" ") &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      ) &&
    !/(?:^|\/)(?:node_modules|dist|build|coverage|credentials)(?:\/|$)|(?:^|\/)(?:id_rsa|id_ed25519|credentials\.json|secrets?\.json)$|\.(?:pem|p12|pfx|key|env)$/i.test(
      file,
    )
  );
}

function patchLines(value: string | undefined, prefix: string): { count: number; lines: string[] } {
  if (!value) return { count: 0, lines: [] };
  const chunks = value.split("\n");
  const ended = value.endsWith("\n");
  if (ended) chunks.pop();
  const lines = chunks.map((chunk) => prefix + chunk);
  if (!ended) lines.push("\\ No newline at end of file");
  return { count: chunks.length, lines };
}

function patchFile(file: string, old: string | undefined, content: string | null): string {
  const before = patchLines(old, "-");
  const after = patchLines(content ?? undefined, "+");
  const header = [`diff --git a/${file} b/${file}`];
  if (old === undefined) header.push("new file mode 100644");
  else if (content === null) header.push("deleted file mode 100644");
  header.push(
    old === undefined ? "--- /dev/null" : `--- a/${file}\t`,
    content === null ? "+++ /dev/null" : `+++ b/${file}\t`,
  );
  if (before.count || after.count)
    header.push(
      `@@ -${before.count ? 1 : 0},${before.count} +${after.count ? 1 : 0},${after.count} @@`,
      ...before.lines,
      ...after.lines,
    );
  return `${header.join("\n")}\n`;
}

export async function runTextWorkspaceTurn(
  input: WorkPromptInput,
  scratch: string,
  ask: (prompt: string) => Promise<string>,
): Promise<string> {
  const patterns = input.ownedPaths ?? ["**"];
  const visible = new Map<string, string>();
  if (input.work?.role !== "verify") {
    let bytes = 0;
    for (const [file, content] of await capturePlainFolderSnapshot(input.cwd)) {
      const size = Buffer.byteLength(content);
      if (
        !safeProjectFile(file) ||
        !isOwnedFile(file, patterns) ||
        containsSensitiveSecret(content) ||
        bytes + size > 120_000 ||
        size > 48_000 ||
        content.includes("\ufffd")
      )
        continue;
      visible.set(file, content);
      bytes += size;
    }
  }
  const prompt = [
    input.prompt,
    "You are working through a file broker. Use only the project text provided below; shell, file tools, web and MCP are unavailable.",
    input.writable
      ? 'Implement the assignment by returning ONLY a JSON object {"summary":"...","files":[{"path":"relative/path","content":"full updated file text"}]}. To delete a visible file set content to null. Only edit listed or new ordinary project files. Do not claim to have run tests.'
      : "Use the supplied evidence to answer in plain text. Distinguish static checks from tests executed.",
    `Project text files: ${JSON.stringify(Object.fromEntries(visible))}`,
  ].join("\n\n");
  const reply = (await ask(prompt)).trim();
  input.signal.throwIfAborted();
  if (!input.writable) return reply;
  let body: unknown;
  try {
    body = JSON.parse(reply.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
  } catch {
    throw new Error("Agent 返回的文件变更不是有效 JSON。");
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("summary" in body) ||
    typeof body.summary !== "string" ||
    !body.summary.trim() ||
    !("files" in body) ||
    !Array.isArray(body.files) ||
    !body.files.length ||
    body.files.length > 30
  )
    throw new Error("Agent 未返回有效的文件变更和摘要。");
  const changes = new Set<string>();
  const patches: string[] = [];
  const root = await realpath(input.cwd);
  for (const edit of body.files as unknown[]) {
    if (
      !edit ||
      typeof edit !== "object" ||
      !("path" in edit) ||
      typeof edit.path !== "string" ||
      !safeProjectFile(edit.path) ||
      !isOwnedFile(edit.path, patterns) ||
      !("content" in edit) ||
      (edit.content !== null && (typeof edit.content !== "string" || edit.content.includes("\0")))
    )
      throw new Error("Agent 提交了越界、重复或无效的文件变更。");
    const key = process.platform === "linux" ? edit.path : edit.path.normalize("NFC").toLowerCase();
    if (changes.has(key)) throw new Error("Agent 返回了重复的文件路径。");
    changes.add(key);
    const expected = visible.get(edit.path);
    const target = path.join(root, edit.path);
    let current = root;
    for (const part of edit.path.split("/")) {
      current = path.join(current, part);
      const st = await lstat(current).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined;
        throw err;
      });
      if (!st) break;
      if (
        st.isSymbolicLink() ||
        (current !== target && !st.isDirectory()) ||
        (current === target && !st.isFile())
      )
        throw new Error("变更路径不是工作区内的普通文件。");
      if (
        current === target &&
        (expected === undefined || (await readFile(target, "utf8")) !== expected)
      )
        throw new Error("目标文件未列入上下文或已被修改。");
    }
    if (edit.content === null && expected === undefined)
      throw new Error("待删除的文件未列入上下文。");
    if (edit.content !== expected) patches.push(patchFile(edit.path, expected, edit.content));
  }
  if (!patches.length) throw new Error("Agent 返回的内容没有文件变更。");
  const patch = path.join(scratch, "changes.patch");
  await writeFile(patch, patches.join(""), { mode: 0o600 });
  // git apply validates every hunk before touching any file. The prefix keeps
  // an in-place subdirectory inside a larger repository scoped to that directory.
  const gitEnv = {
    ...process.env,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_PREFIX: undefined,
  };
  const prefix = (
    await exec("git", ["rev-parse", "--show-prefix"], {
      cwd: root,
      signal: input.signal,
      env: gitEnv,
    }).catch(() => ({ stdout: "" }))
  ).stdout.trim();
  await exec(
    "git",
    [
      "apply",
      "--whitespace=nowarn",
      ...(prefix ? [`--directory=${prefix.replace(/\/$/, "")}`] : []),
      "--",
      patch,
    ],
    { cwd: root, signal: input.signal, timeout: 15_000, env: gitEnv },
  );
  return body.summary;
}
