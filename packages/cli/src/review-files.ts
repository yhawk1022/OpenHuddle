import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_REVIEW_EVIDENCE_BYTES } from "@openhuddle/protocol";

export interface ReviewFileSource {
  sliceId: string;
  changedFiles: readonly string[];
  patch?: string;
}

export interface ReviewArtifact {
  path: string;
  sliceId: string;
  bytes: number;
  sha256: string;
}

function safeFileName(file: string): boolean {
  return (
    file.length > 0 &&
    file.length <= 260 &&
    ![...file].some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === "\\" || c === ":",
    ) &&
    file
      .split("/")
      .every(
        (segment) =>
          segment.length > 0 &&
          !segment.startsWith(".") &&
          !segment.endsWith(".") &&
          !segment.endsWith(" ") &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment),
      )
  );
}

// Decode a single Git creation record without applying or executing a patch.
// Matching the Git blob ID catches redaction, line-ending conversion and truncation.
function newBlob(lines: string[], file: string): Buffer | undefined {
  if (!/^new file mode 100(?:644|755)$/.test(lines[1] ?? "")) return;
  const index = /^index 0+\.\.([0-9a-f]{7,64})$/.exec(lines[2] ?? "");
  if (!index?.[1]) return;
  let text = "";
  if (lines.length !== 3) {
    if (lines[3] !== "--- /dev/null" || lines[4]?.replace(/\t$/, "") !== `+++ b/${file}`) return;
    const hunk = /^@@ -0,0 \+1(?:,(\d+))? @@$/.exec(lines[5] ?? "");
    if (!hunk) return;
    const count = Number(hunk[1] ?? 1);
    const records = lines.slice(6);
    const noFinalNewline = records.at(-1) === "\\ No newline at end of file";
    if (noFinalNewline) records.pop();
    if (!count || records.length !== count || records.some((l) => !l.startsWith("+"))) return;
    text = records.map((l) => l.slice(1)).join("\n") + (noFinalNewline ? "" : "\n");
  }
  if (text.includes("\0") || text.includes("\ufffd")) return;
  const data = Buffer.from(text);
  const gitHeader = `blob ${data.length}\0`;
  const matches = ["sha1", "sha256"].some((algorithm) =>
    createHash(algorithm)
      .update(gitHeader)
      .update(data)
      .digest("hex")
      .startsWith(index[1] ?? "-"),
  );
  return matches ? data : undefined;
}

export async function materializeReviewFiles(
  root: string,
  sources: ReviewFileSource[],
): Promise<ReviewArtifact[]> {
  if (!(await lstat(root)).isDirectory()) throw new Error("复核临时目录不可用。");
  const occupants = new Map<string, number>();
  const parents = new Set<string>();
  const key = (s: string) => s.normalize("NFC").toLowerCase();
  for (const source of sources) {
    for (const file of source.changedFiles) {
      const name = key(file);
      occupants.set(name, (occupants.get(name) ?? 0) + 1);
      let parent = path.posix.dirname(name);
      while (parent !== "." && parent !== "/") {
        parents.add(parent);
        parent = path.posix.dirname(parent);
      }
    }
  }
  const files = new Map<string, { data: Buffer; sliceId: string }>();
  let inputBytes = 0;
  for (const source of sources) {
    if (!source.patch) continue;
    inputBytes += Buffer.byteLength(source.patch);
    if (inputBytes > MAX_REVIEW_EVIDENCE_BYTES) throw new Error("复核材料超过本轮容量。");
    const paths = new Map<string, string>();
    for (const file of source.changedFiles) {
      if (!safeFileName(file) || occupants.get(key(file)) !== 1 || parents.has(key(file))) continue;
      const segments = file.split("/");
      if (segments.some((_, i) => i > 0 && occupants.has(key(segments.slice(0, i).join("/")))))
        continue;
      paths.set(`a/${file} b/${file}`, file);
    }
    const sections = source.patch.split(/^diff --git /m).slice(1);
    const seen = new Set<string>();
    for (const section of sections) {
      const lines = section.split("\n");
      while (lines.at(-1) === "") lines.pop();
      const header = lines[0] ?? "";
      const file = paths.get(header);
      if (!file) continue;

      // A second section for the same path might undo or replace the creation.
      if (seen.has(file)) {
        files.delete(file);
        continue;
      }
      seen.add(file);
      const data = newBlob(lines, file);
      if (data) files.set(file, { data, sliceId: source.sliceId });
    }
  }
  const artifacts: ReviewArtifact[] = [];
  for (const [file, { data, sliceId }] of files) {
    if (artifacts.length >= 200) break;
    const segments = file.split("/");
    let directory = root;
    let valid = true;
    for (const segment of segments.slice(0, -1)) {
      directory = path.join(directory, segment);
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      if (!(await lstat(directory)).isDirectory()) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    try {
      await writeFile(path.join(root, file), data, { flag: "wx", mode: 0o400 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    artifacts.push({
      path: file,
      sliceId,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  return artifacts;
}
