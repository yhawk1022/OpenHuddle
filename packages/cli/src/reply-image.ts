/**
 * @module cli/reply-image
 * @description 识别主人发图请求，并从单次回合的私有目录读取固定名称、受限大小的 PNG。
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { MAX_MESSAGE_ATTACHMENT_BYTES, type MessageAttachmentUpload } from "@openhuddle/protocol";
import { PNG } from "pngjs";

/** Codex 图片输出的固定文件名。模型回复里的文件路径不参与解析。 */
export const REPLY_IMAGE_NAME = "reply.png";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 16_000_000;
const TARGET_PIXEL_COUNTS = [4_000_000, 2_000_000, 1_000_000];
const IMAGE_REQUEST =
  /(?:发|贴|附|画|绘制|生成|渲染|做).{0,32}(?:图片|图像|插图|配图|架构图|流程图|示意图|图表|海报|图解|图$)|\b(?:send|attach|draw|illustrate|make|generate|render|create)\b.{0,48}\b(?:image|picture|photo|diagram|chart|illustration|poster)s?\b/iu;
const IMAGE_NEGATION = /不要|不用|无需|不必|别|禁止|\b(?:don['’]t|do not|never|without)\b/iu;

/**
 * 判断一条已由调用方验证为主人所发的消息是否请求生成或发送图片。
 * @param content - 本轮触发消息的正文
 * @returns 是否启用受限的图片输出
 */
export function requestsReplyImage(content: string): boolean {
  return content
    .split(/[，。；！？,.!?;\n]/u)
    .some((clause) => IMAGE_REQUEST.test(clause.trim()) && !IMAGE_NEGATION.test(clause));
}

function resizePng(source: PNG, width: number, height: number): PNG {
  if (source.width === width && source.height === height) {
    return source;
  }
  const result = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sourceRow = Math.floor(((y + 0.5) * source.height) / height) * source.width;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.floor(((x + 0.5) * source.width) / width);
      const input = 4 * (sourceRow + sourceX);
      const output = 4 * (y * width + x);
      source.data.copy(result.data, output, input, input + 4);
    }
  }
  return result;
}

function compressReplyPng(bytes: Buffer): Buffer | undefined {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  // pngjs 的非交错解码限制解压大小。先读 IHDR，避免超大像素缓冲和不受限的交错解压。
  if (width === 0 || height === 0 || width * height > MAX_SOURCE_PIXELS || bytes[28] !== 0) {
    return undefined;
  }

  const source = PNG.sync.read(bytes);
  for (const pixelCount of TARGET_PIXEL_COUNTS) {
    const scale = Math.min(1, Math.sqrt(pixelCount / (width * height)));
    const encoded = PNG.sync.write(
      resizePng(
        source,
        Math.max(1, Math.floor(width * scale)),
        Math.max(1, Math.floor(height * scale)),
      ),
    );
    if (encoded.byteLength <= MAX_MESSAGE_ATTACHMENT_BYTES) {
      return encoded;
    }
  }
  return undefined;
}

/**
 * 读取单次回合目录内的 PNG，压缩超限文件并避免跟随文件链接。
 * @param outputDir - 监听器为本次推理创建的私有目录
 * @returns 可随消息提交的附件，或者未找到有效输出时的 `undefined`
 */
export async function readReplyImage(
  outputDir: string,
): Promise<MessageAttachmentUpload | undefined> {
  try {
    const path = join(outputDir, REPLY_IMAGE_NAME);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.nlink !== 1) {
      return undefined;
    }
    // 打开后核对文件身份。无 O_NOFOLLOW 的平台也不能通过替换目录项绕过校验。
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.dev !== entry.dev ||
        stat.ino !== entry.ino ||
        stat.size < 33 ||
        stat.size > MAX_SOURCE_BYTES
      ) {
        return undefined;
      }
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) {
          return undefined;
        }
        offset += bytesRead;
      }
      if (
        !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
        bytes.readUInt32BE(8) !== 13 ||
        bytes.toString("ascii", 12, 16) !== "IHDR"
      ) {
        return undefined;
      }
      const image = bytes.length <= MAX_MESSAGE_ATTACHMENT_BYTES ? bytes : compressReplyPng(bytes);
      return image === undefined
        ? undefined
        : { mimeType: "image/png", data: image.toString("base64") };
    } finally {
      await file.close();
    }
  } catch {
    // 无输出、链接被替换或读失败时仍允许本轮返回纯文本。
    return undefined;
  }
}
