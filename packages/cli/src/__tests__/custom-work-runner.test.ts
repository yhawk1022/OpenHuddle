import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type WorkPromptInput, runWorkPrompt } from "../work-cli-process.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "oh-custom-work-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function runAdapter(script: string, role: "write" | "verify" = "write") {
  const adapter = join(directory, "adapter.cjs");
  const input: WorkPromptInput = {
    runner: { kind: "custom", command: `"${process.execPath}" "${adapter}"` },
    work: { itemId: "wrk_example", sliceId: "slc_example", role, leaseVersion: 2 },
    platform: "cursor",
    homeDir: directory,
    cwd: directory,
    signal: new AbortController().signal,
    writable: role === "write",
    prompt: "Use the configured device adapter.",
  };
  return writeFile(adapter, script).then(() => runWorkPrompt(input));
}
const receive = `
const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
if (process.env.OPENHUDDLE_EVENT_TYPE !== 'work.slice' || request.type !== 'openhuddle.work.slice') process.exit(2);
const receipt = { type: 'openhuddle.work.result', sliceId: request.sliceId, leaseVersion: request.leaseVersion, summary: 'Device processed the assigned slice' };
`;

it("runs the trusted local adapter in its worktree with the actual fenced task envelope", async () => {
  expect(
    await runAdapter(
      `${receive}
    fs.writeFileSync('result.txt', request.itemId + ' ' + request.prompt);
    console.log(JSON.stringify(receipt));
  `,
    ),
  ).toBe("Device processed the assigned slice");
  expect(await readFile(join(directory, "result.txt"), "utf8")).toBe(
    "wrk_example Use the configured device adapter.",
  );
});

it("rejects ordinary chat stdout and stale receipts after the command exits successfully", async () => {
  await expect(runAdapter("console.log('Here is my chat reply')")).rejects.toThrow(
    "openhuddle.work.result",
  );
  await expect(
    runAdapter(`${receive}console.log(JSON.stringify({...receipt, leaseVersion: 1}))`),
  ).rejects.toThrow("leaseVersion");
});

it("requires a structured independent verdict from a verification adapter", async () => {
  await expect(
    runAdapter(`${receive}console.log(JSON.stringify(receipt))`, "verify"),
  ).rejects.toThrow("verdict");
  expect(
    await runAdapter(
      `${receive}console.log(JSON.stringify({...receipt, verdict:'changes_requested'}))`,
      "verify",
    ),
  ).toMatch(/VERDICT: CHANGES_REQUESTED$/);
});

it("lets a custom verifier request an owner decision only for its current lease", async () => {
  const attention = {
    type: "openhuddle.work.attention",
    question: "Which target should I verify?",
    options: ["Mobile", "Desktop"],
  };
  const encode = JSON.stringify(attention);
  await expect(
    runAdapter(`${receive}console.log(JSON.stringify({...receipt, ...${encode}}))`, "verify"),
  ).rejects.toMatchObject({
    attention: { question: attention.question, options: attention.options },
  });
  await expect(
    runAdapter(
      `${receive}console.log(JSON.stringify({...receipt, ...${encode}, leaseVersion:1}))`,
      "verify",
    ),
  ).rejects.toThrow("leaseVersion");
});

it("preserves quoted control syntax in a successful structured result", async () => {
  const summary =
    'Documented the following example:\nNEEDS_INPUT: {"question":"Example?","options":["A","B"]}';
  await expect(
    runAdapter(
      `${receive}console.log(JSON.stringify({...receipt, summary: ${JSON.stringify(summary)}}))`,
    ),
  ).resolves.toBe(summary);
});
