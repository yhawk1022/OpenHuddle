/**
 * @module cli/tests/reply-image
 * @description 验证 Codex 只读取本轮约定的 PNG，链接、超限或非 PNG 文件均不会发送。
 */
import { randomFillSync } from "node:crypto";
import { link, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MESSAGE_ATTACHMENT_BYTES } from "@openhuddle/protocol";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPLY_IMAGE_NAME, readReplyImage, requestsReplyImage } from "../reply-image.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFzsAAAAASUVORK5CYII=",
  "base64",
);

describe("Codex image replies", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "openhuddle-test-image-"));
  });

  afterEach(async () => {
    await rm(outputDir, { force: true, recursive: true });
  });

  it("recognizes a direct image request without treating text or negated requests as image requests", () => {
    expect(requestsReplyImage("@Codex 发图片")).toBe(true);
    expect(requestsReplyImage("画一个项目逻辑架构图，发到这个群里")).toBe(true);
    expect(requestsReplyImage("Please generate an architecture diagram.")).toBe(true);
    expect(requestsReplyImage("只发文字，不要发图片。")).toBe(false);
    expect(requestsReplyImage("Describe the current architecture.")).toBe(false);
  });

  it("returns the fixed PNG and rejects missing, invalid or oversized output", async () => {
    const path = join(outputDir, REPLY_IMAGE_NAME);
    await writeFile(join(outputDir, "other.png"), png);
    await expect(readReplyImage(outputDir)).resolves.toBeUndefined();

    await writeFile(path, "not a PNG".repeat(5));
    await expect(readReplyImage(outputDir)).resolves.toBeUndefined();

    await writeFile(path, png);
    await expect(readReplyImage(outputDir)).resolves.toEqual({
      mimeType: "image/png",
      data: png.toString("base64"),
    });

    await truncate(path, 64 * 1024 * 1024 + 1);
    await expect(readReplyImage(outputDir)).resolves.toBeUndefined();
  });

  it("shrinks and re-encodes a real PNG over the upload limit", async () => {
    const large = new PNG({ width: 1800, height: 1500 });
    randomFillSync(large.data);
    const input = PNG.sync.write(large, { deflateLevel: 0 });
    expect(input.byteLength).toBeGreaterThan(MAX_MESSAGE_ATTACHMENT_BYTES);
    await writeFile(join(outputDir, REPLY_IMAGE_NAME), input);

    const attachment = await readReplyImage(outputDir);
    expect(attachment?.mimeType).toBe("image/png");
    const encoded = Buffer.from(attachment?.data ?? "", "base64");
    expect(encoded.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_ATTACHMENT_BYTES);
    const compressed = PNG.sync.read(encoded);
    expect(compressed.width).toBeLessThan(large.width);
    expect(compressed.width / compressed.height).toBeCloseTo(large.width / large.height, 2);
  });

  it("rejects hard links even when the target is a valid PNG", async () => {
    const target = join(outputDir, "original.png");
    await writeFile(target, png);
    await link(target, join(outputDir, REPLY_IMAGE_NAME));
    await expect(readReplyImage(outputDir)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("does not follow a symbolic link", async () => {
    const target = join(outputDir, "original.png");
    await writeFile(target, png);
    await symlink(target, join(outputDir, REPLY_IMAGE_NAME));
    await expect(readReplyImage(outputDir)).resolves.toBeUndefined();
  });
});
