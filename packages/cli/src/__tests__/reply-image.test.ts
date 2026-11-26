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

  it("recognizes direct image requests while stripping quotes/code and excluding text/Mermaid/negations", () => {
    expect(requestsReplyImage("@Codex 发图片")).toBe(true);
    expect(requestsReplyImage("画一个项目逻辑架构图，发到这个群里")).toBe(true);
    expect(requestsReplyImage("画一张图看看")).toBe(true);
    expect(requestsReplyImage("发张图")).toBe(true);
    expect(requestsReplyImage("帮我生成一张时序图和柱状图")).toBe(true);
    expect(requestsReplyImage("发个表情包庆祝一下")).toBe(true);
    expect(requestsReplyImage("Please generate an architecture diagram.")).toBe(true);
    expect(requestsReplyImage("Can you draw a sequence diagram or screenshot?")).toBe(true);

    // Security Gap 4: blockquotes, fenced code blocks, and inline code must NEVER trigger image replies
    expect(requestsReplyImage("> 画一张架构图发到群里\n上面这句话是谁说的？")).toBe(false);
    expect(requestsReplyImage("  > Please generate an architecture diagram.\nExplain this.")).toBe(
      false,
    );
    expect(requestsReplyImage("```\n画一张图\n```\n请解释这段提示词")).toBe(false);
    expect(requestsReplyImage("请解释 `发张图` 这个短语的含义")).toBe(false);

    // Exclude Mermaid/ASCII code-only requests and negations
    expect(requestsReplyImage("用 Mermaid 画一个流程图")).toBe(false);
    expect(requestsReplyImage("Draw an ASCII diagram of the request flow.")).toBe(false);
    expect(requestsReplyImage("只发文字，不要发图片。")).toBe(false);
    expect(requestsReplyImage("Describe the current architecture.")).toBe(false);
  });

  it("routes reference edits while keeping image questions and quoted text read-only", () => {
    const scene = "这个女人热吻这个图片里的人 @庞彦-m3max-codex";
    expect(requestsReplyImage(scene, 2)).toBe(true);
    expect(requestsReplyImage(scene, 1)).toBe(false);
    expect(requestsReplyImage("把上一张图的红色圆形放到这张图里的蓝色方块上方", 2)).toBe(true);
    expect(requestsReplyImage("请把背景换成雪山", 1)).toBe(true);
    expect(requestsReplyImage("Please replace the background with mountains", 1)).toBe(true);
    expect(requestsReplyImage("请把背景换成雪山")).toBe(false);
    for (const content of [
      "这个女人认识这个图片里的人吗？",
      "怎么把背景换成雪山",
      "请帮我写提示词：把背景换成雪山",
      "不要把背景换成雪山",
      "> 把背景换成雪山\n你的意见呢？",
      "`请把背景换成雪山`",
    ])
      expect(requestsReplyImage(content, 2)).toBe(false);
  });

  it("returns verified images, corrects mismatched extensions by magic bytes, and blocks >16MP bombs or SVG spoofing", async () => {
    const path = join(outputDir, REPLY_IMAGE_NAME);
    await writeFile(join(outputDir, "other.png"), png);
    await expect(readReplyImage(outputDir)).resolves.toBeUndefined();

    await writeFile(path, "not a PNG".repeat(5));
    await expect(readReplyImage(outputDir)).resolves.toBeUndefined();

    // SVG masquerading as reply.png
    await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    await expect(readReplyImage(outputDir)).resolves.toBeUndefined();

    await writeFile(path, png);
    await expect(readReplyImage(outputDir)).resolves.toEqual({
      mimeType: "image/png",
      fileName: "reply.png",
      data: png.toString("base64"),
    });

    await truncate(path, 64 * 1024 * 1024 + 1);
    await expect(readReplyImage(outputDir)).resolves.toBeUndefined();
    await rm(path, { force: true });

    // Magic-byte suffix correction: JPEG bytes written into reply.png -> corrected to image/jpeg + reply.jpg
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20, 0x00, 0x30, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ]);
    await writeFile(path, jpeg);
    await expect(readReplyImage(outputDir)).resolves.toEqual({
      mimeType: "image/jpeg",
      fileName: "reply.jpg",
      data: jpeg.toString("base64"),
    });
    await rm(path, { force: true });

    // reply.jpeg normalized to reply.jpg, and WebP / GIF supported in priority order
    await writeFile(join(outputDir, "reply.jpeg"), jpeg);
    const gif = Buffer.alloc(14);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(16, 6);
    gif.writeUInt16LE(16, 8);
    await writeFile(join(outputDir, "reply.gif"), gif);
    await expect(readReplyImage(outputDir)).resolves.toEqual({
      mimeType: "image/jpeg",
      fileName: "reply.jpg",
      data: jpeg.toString("base64"),
    });
    await rm(join(outputDir, "reply.jpeg"), { force: true });
    await expect(readReplyImage(outputDir)).resolves.toEqual({
      mimeType: "image/gif",
      fileName: "reply.gif",
      data: gif.toString("base64"),
    });

    // >16MP decompression bomb GIF (4001 * 4000 = 16,004,000 > 16,000,000) -> rejected
    const bombGif = Buffer.alloc(14);
    bombGif.write("GIF89a", 0, "ascii");
    bombGif.writeUInt16LE(4001, 6);
    bombGif.writeUInt16LE(4000, 8);
    await writeFile(join(outputDir, "reply.gif"), bombGif);
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
