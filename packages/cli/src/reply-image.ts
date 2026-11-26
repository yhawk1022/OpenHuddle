/**
 * @module cli/reply-image
 * @description 识别主人发图请求、校验多格式图片魔数与真实帧尺寸，并从单次回合私有目录安全读取图片。
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { MAX_MESSAGE_ATTACHMENT_BYTES, type MessageAttachmentUpload } from "@openhuddle/protocol";
import { PNG } from "pngjs";

/** 默认首选发图文件名（保持向后兼容）。模型回复正文中的路径不参与解析。 */
export const REPLY_IMAGE_NAME = "reply.png";

/** 按优先级扫描的受限发图文件名列表。 */
export const REPLY_IMAGE_CANDIDATES = [
  "reply.png",
  "reply.jpg",
  "reply.jpeg",
  "reply.webp",
  "reply.gif",
] as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
export const MAX_IMAGE_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 32_768;
export const MAX_SOURCE_PIXELS = 16_000_000;
const TARGET_PIXEL_COUNTS = [4_000_000, 2_000_000, 1_000_000, 500_000, 250_000, 100_000, 25_000];

const IMAGE_REQUEST =
  /(?:发|贴|附|传|晒|给|来|画|绘制|生成|渲染|制作|做|出|导|截).{0,32}(?:图片|图像|插图|配图|架构图|流程图|时序图|拓扑图|状态图|类图|柱状图|折线图|饼图|甘特图|思维导图|脑图|示意图|图表|海报|草图|线框图|原型图|效果图|截图|快照|照片|壁纸|头像|表情包|贴纸|(?:一|几|两)?\s*[张幅个]\s*图|图(?:片|像|表|解)?$)|(?:画|发|来|给|做|生成|绘制|贴|附)(?:一|几|两)?[张幅]图|\b(?:send|post|share|attach|upload|draw|sketch|illustrate|plot|make|generate|render|create|produce|export|show)\b.{0,48}\b(?:images?|pictures?|photos?|diagrams?|flowcharts?|charts?|graphs?|plots?|illustrations?|posters?|sketches?|wireframes?|screenshots?|memes?|stickers?|infographics?|visualizations?|pngs?|jpegs?|webps?|gifs?)\b/iu;
const IMAGE_NEGATION =
  /不要|不用|无需|不必|别|禁止|勿|\b(?:don['’]?t|do\s+not|never|no\s+need\s+to|without)\b/iu;
const PURE_CODE_DIAGRAM_ONLY =
  /^(?!.*(?:png|jpe?g|webp|gif|图片|图像|配图|表情包|贴纸|\bimages?\b|\bpictures?\b)).*(?:\b(?:mermaid|ascii|plantuml)\b|字符画|纯文本)/iu;

/**
 * 魔数与帧头核验通过后的真实图片格式元数据。
 */
export interface DetectedImageInfo {
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly ext: "png" | "jpg" | "gif" | "webp";
  readonly width: number;
  readonly height: number;
}

/**
 * 清洗附件基础文件名：剔除路径分隔符、控制字符、双向伪装符与前导异常字符。
 */
export function sanitizeAttachmentFileName(rawName: string): string | undefined {
  const withoutControls = rawName
    .replace(/[/\\\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/gu, "")
    .trim()
    .replace(/^[.\-\s]+/u, "")
    .slice(0, 255);
  if (withoutControls.length === 0 || withoutControls === "." || withoutControls === "..") {
    return undefined;
  }
  return withoutControls;
}

function parseJpegDimensions(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 4 || !bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return undefined;
  }
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return undefined;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) {
      return undefined;
    }
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00 || marker === 0xd9 || marker === 0xda) {
      return undefined;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.length) {
      return undefined;
    }
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return undefined;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (segmentLength < 8) {
        return undefined;
      }
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return undefined;
}

function parseWebpDimensions(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | undefined {
  if (
    bytes.length < 25 ||
    bytes.toString("latin1", 0, 4) !== "RIFF" ||
    bytes.toString("latin1", 8, 12) !== "WEBP"
  ) {
    return undefined;
  }
  const chunkType = bytes.toString("latin1", 12, 16);
  const chunkSize = bytes.readUInt32LE(16);
  if (20 + chunkSize > bytes.length) {
    return undefined;
  }
  if (chunkType === "VP8 ") {
    if (
      chunkSize < 10 ||
      bytes.length < 30 ||
      ((bytes[20] ?? 1) & 0x01) !== 0 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) {
      return undefined;
    }
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunkType === "VP8L") {
    if (chunkSize < 5 || bytes.length < 25 || bytes[20] !== 0x2f) {
      return undefined;
    }
    const bits = bytes.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (chunkType === "VP8X") {
    if (chunkSize < 10 || bytes.length < 30) {
      return undefined;
    }
    return {
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    };
  }
  return undefined;
}

/**
 * 按真实文件头 Magic Bytes 识别受支持的图片格式，并强制核验像素宽高（拒绝 SVG/HTML 伪装与 >16MP 解压炸弹）。
 */
export function detectImageFormatAndDimensions(bytes: Buffer): DetectedImageInfo | undefined {
  let candidate: DetectedImageInfo | undefined;

  if (
    bytes.length >= 33 &&
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    candidate = {
      mimeType: "image/png",
      ext: "png",
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  } else if (bytes.length >= 10) {
    const gifHeader = bytes.toString("latin1", 0, 6);
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
      candidate = {
        mimeType: "image/gif",
        ext: "gif",
        width: bytes.readUInt16LE(6),
        height: bytes.readUInt16LE(8),
      };
    } else if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
      const dims = parseJpegDimensions(bytes);
      if (dims !== undefined) {
        candidate = { mimeType: "image/jpeg", ext: "jpg", ...dims };
      }
    } else if (
      bytes.length >= 25 &&
      bytes.toString("latin1", 0, 4) === "RIFF" &&
      bytes.toString("latin1", 8, 12) === "WEBP"
    ) {
      const dims = parseWebpDimensions(bytes);
      if (dims !== undefined) {
        candidate = { mimeType: "image/webp", ext: "webp", ...dims };
      }
    }
  }

  if (
    candidate === undefined ||
    candidate.width <= 0 ||
    candidate.height <= 0 ||
    candidate.width > MAX_IMAGE_DIMENSION ||
    candidate.height > MAX_IMAGE_DIMENSION ||
    candidate.width * candidate.height > MAX_SOURCE_PIXELS
  ) {
    return undefined;
  }
  return candidate;
}

/**
 * 判断一条已由调用方验证为主人所发的消息是否请求生成或发送图片。
 *
 * @remarks
 * 先剥离围栏代码块、Markdown 引用行 `>` 与行内反引号，防止引用外部文字或粘贴代码误触发发图沙箱。
 *
 * @param content - 本轮触发消息的正文
 * @returns 是否启用受限的图片输出
 */
export function requestsReplyImage(content: string): boolean {
  const stripped = content
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/~~~[\s\S]*?~~~/g, "\n")
    .replace(/^\s*>.*$/gm, "")
    .replace(/`[^`\n]*`/g, " ");

  return stripped.split(/[，。；！？,.!?;\r\n]+/u).some((rawClause) => {
    const clause = rawClause.trim();
    if (clause.length === 0) {
      return false;
    }
    if (IMAGE_NEGATION.test(clause) || PURE_CODE_DIAGRAM_ONLY.test(clause)) {
      return false;
    }
    return IMAGE_REQUEST.test(clause);
  });
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

/**
 * 等比缩放超限非交错 PNG 至指定字节上限内。
 */
export function compressPngToMaxBytes(
  bytes: Buffer,
  maxBytes: number = MAX_MESSAGE_ATTACHMENT_BYTES,
): Buffer | undefined {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return undefined;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  // pngjs 的非交错解码限制解压大小。先读 IHDR，避免超大像素缓冲和不受限的交错解压。
  if (
    width === 0 ||
    height === 0 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_SOURCE_PIXELS ||
    bytes[28] !== 0
  ) {
    return undefined;
  }
  if (bytes.byteLength <= maxBytes) {
    return bytes;
  }

  let source: PNG;
  try {
    source = PNG.sync.read(bytes);
  } catch {
    return undefined;
  }
  const totalPixels = width * height;
  const estimatedPixels = Math.max(
    1,
    Math.floor((totalPixels * maxBytes * 0.8) / bytes.byteLength),
  );
  const seenDims = new Set<string>();
  for (const pixelCount of [estimatedPixels, ...TARGET_PIXEL_COUNTS, 4_000, 400, 64]) {
    const scale = Math.min(1, Math.sqrt(pixelCount / totalPixels));
    const targetW = Math.max(1, Math.floor(width * scale));
    const targetH = Math.max(1, Math.floor(height * scale));
    const dimKey = `${targetW}x${targetH}`;
    if (seenDims.has(dimKey)) {
      continue;
    }
    seenDims.add(dimKey);
    const encoded = PNG.sync.write(resizePng(source, targetW, targetH));
    if (encoded.byteLength <= maxBytes) {
      return encoded;
    }
  }
  return undefined;
}

export const compressReplyPng = compressPngToMaxBytes;

/**
 * 按优先级扫描单次回合私有目录内的 `reply.{png,jpg,jpeg,webp,gif}`，严格拦截符号链接/硬链接与畸形头。
 *
 * @param outputDir - 监听器为本次推理创建的私有目录
 * @returns 可随消息提交的附件（按真实魔数纠偏 `mimeType` 与规范后缀 `fileName`），或未找到有效输出时的 `undefined`
 */
export async function readReplyImage(
  outputDir: string,
): Promise<MessageAttachmentUpload | undefined> {
  for (const candidateName of REPLY_IMAGE_CANDIDATES) {
    const path = join(outputDir, candidateName);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      return undefined;
    }

    if (!entry.isFile() || entry.nlink !== 1) {
      return undefined;
    }

    try {
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
          stat.size < 10 ||
          stat.size > MAX_IMAGE_SOURCE_BYTES
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

        const detected = detectImageFormatAndDimensions(bytes);
        if (detected === undefined) {
          return undefined;
        }

        let finalBytes: Buffer | undefined = bytes;
        if (bytes.byteLength > MAX_MESSAGE_ATTACHMENT_BYTES) {
          if (detected.mimeType !== "image/png") {
            return undefined;
          }
          finalBytes = compressPngToMaxBytes(bytes, MAX_MESSAGE_ATTACHMENT_BYTES);
        }
        if (finalBytes === undefined) {
          return undefined;
        }

        return {
          mimeType: detected.mimeType,
          fileName: `reply.${detected.ext}`,
          data: finalBytes.toString("base64"),
        };
      } finally {
        await file.close();
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}
