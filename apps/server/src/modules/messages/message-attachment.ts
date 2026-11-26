/**
 * @module server/modules/messages/message-attachment
 * @description 在消息写入边界验证附件编码、大小与媒体文件头。
 * 附件类型只取自协议白名单，浏览器不依据文件名或者用户输入猜测媒体类型。
 */
import {
  MAX_MESSAGE_ATTACHMENT_BYTES,
  type MessageAttachmentMimeType,
  type MessageAttachmentUpload,
  assertNever,
} from "@openhuddle/protocol";
import { AppError } from "../../infra/errors.js";
import type { StoredMessageAttachment } from "./messages.repo.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const EBML_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const WEBM_DOC_TYPE = Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
const MAX_IMAGE_DIMENSION = 32_768;
const MAX_IMAGE_PIXELS = 16_000_000;

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function parseJpegDimensions(bytes: Buffer): ImageDimensions | undefined {
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
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
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

function parseWebpDimensions(bytes: Buffer): ImageDimensions | undefined {
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
 * 纯 Buffer 解析受支持图片格式的真实像素宽高（PNG IHDR / GIF 逻辑屏 / WebP VP8|VP8L|VP8X / JPEG SOF）。
 */
export function parseImageDimensions(
  bytes: Buffer,
  mimeType: "image/png" | "image/gif" | "image/webp" | "image/jpeg",
): ImageDimensions | undefined {
  switch (mimeType) {
    case "image/png": {
      if (
        bytes.length < 33 ||
        !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
        bytes.readUInt32BE(8) !== 13 ||
        bytes.toString("ascii", 12, 16) !== "IHDR"
      ) {
        return undefined;
      }
      return {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
      };
    }
    case "image/gif": {
      if (bytes.length < 10) {
        return undefined;
      }
      const header = bytes.toString("latin1", 0, 6);
      if (header !== "GIF87a" && header !== "GIF89a") {
        return undefined;
      }
      return {
        width: bytes.readUInt16LE(6),
        height: bytes.readUInt16LE(8),
      };
    }
    case "image/webp":
      return parseWebpDimensions(bytes);
    case "image/jpeg":
      return parseJpegDimensions(bytes);
    default:
      return assertNever(mimeType);
  }
}

function matchesMagicBytes(bytes: Buffer, mimeType: MessageAttachmentMimeType): boolean {
  switch (mimeType) {
    case "application/octet-stream":
      // 通用附件只作为下载返回，因此保留原始字节，不按用户声明的格式解析。
      return true;
    case "image/jpeg":
      return bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE);
    case "image/png":
      return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
    case "image/gif": {
      const header = bytes.toString("latin1", 0, 6);
      return header === "GIF87a" || header === "GIF89a";
    }
    case "image/webp":
      return (
        bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP"
      );
    case "audio/webm":
      return (
        bytes.subarray(0, EBML_SIGNATURE.length).equals(EBML_SIGNATURE) &&
        bytes.subarray(4, 4096).includes(WEBM_DOC_TYPE)
      );
    case "audio/ogg":
      return bytes.toString("latin1", 0, 4) === "OggS" && bytes[4] === 0;
    case "audio/mp4":
      return (
        bytes.length >= 16 &&
        bytes.toString("latin1", 4, 8) === "ftyp" &&
        bytes.readUInt32BE(0) >= 16 &&
        bytes.readUInt32BE(0) <= bytes.length
      );
    case "audio/mpeg":
      return (
        (bytes.length >= 10 && bytes.toString("latin1", 0, 3) === "ID3") ||
        (bytes.length >= 4 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
      );
    case "audio/wav":
      return (
        bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WAVE"
      );
    default:
      return assertNever(mimeType);
  }
}

/**
 * 解码并验证上传内容；持久化元数据只取自已校验的输入与实际字节长度。
 *
 * @param upload - 请求契约校验后的附件
 * @returns 附件元数据与二进制
 * @throws {AppError} 编码无效、附件超限或文件头与声明类型不符
 */
export function decodeMessageAttachment(
  upload: Readonly<MessageAttachmentUpload>,
): StoredMessageAttachment {
  const bytes = Buffer.from(upload.data, "base64");
  if (bytes.byteLength > MAX_MESSAGE_ATTACHMENT_BYTES) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      statusCode: 413,
      message: "Message attachments must be at most 8 MiB.",
    });
  }

  // Buffer.from 容许空白、URL 安全字母和非规范补位，往返比较保持编码唯一。
  if (bytes.toString("base64") !== upload.data || !matchesMagicBytes(bytes, upload.mimeType)) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      statusCode: 400,
      message: "The attachment must match its declared media type and use canonical base64.",
    });
  }

  let dimensions: ImageDimensions | undefined;
  if (
    upload.mimeType === "image/png" ||
    upload.mimeType === "image/gif" ||
    upload.mimeType === "image/webp" ||
    upload.mimeType === "image/jpeg"
  ) {
    dimensions = parseImageDimensions(bytes, upload.mimeType);
    if (
      dimensions === undefined ||
      dimensions.width <= 0 ||
      dimensions.height <= 0 ||
      dimensions.width > MAX_IMAGE_DIMENSION ||
      dimensions.height > MAX_IMAGE_DIMENSION ||
      dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
    ) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        statusCode: 400,
        message:
          "Image attachments must contain valid frame dimensions within 32768x32768 and at most 16 megapixels.",
      });
    }
  }

  return {
    bytes,
    metadata: {
      mimeType: upload.mimeType,
      byteLength: bytes.byteLength,
      ...(dimensions !== undefined ? { width: dimensions.width, height: dimensions.height } : {}),
      ...(upload.stickerName !== undefined ? { stickerName: upload.stickerName } : {}),
      ...(upload.fileName !== undefined ? { fileName: upload.fileName } : {}),
    },
  };
}
