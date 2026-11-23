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

function matchesMagicBytes(bytes: Buffer, mimeType: MessageAttachmentMimeType): boolean {
  switch (mimeType) {
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
  return {
    bytes,
    metadata: {
      mimeType: upload.mimeType,
      byteLength: bytes.byteLength,
      ...(upload.stickerName !== undefined ? { stickerName: upload.stickerName } : {}),
    },
  };
}
