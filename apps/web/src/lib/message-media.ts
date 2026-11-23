/**
 * @module web/lib/message-media
 * @description 浏览器消息附件本地草稿与传输编码。原始文件在用户发送前只保留在组件内存中。
 */
import type { MessageAttachmentMimeType, MessageAttachmentUpload } from "@openhuddle/protocol";

/** 待提交的媒体草稿，保留原始字节以免在交互期间重复编码。 */
export interface DraftMessageAttachment {
  readonly blob: Blob;
  readonly mimeType: MessageAttachmentMimeType;
  readonly name: string;
}

/**
 * 将单条消息的附件草稿编码为协议请求载荷。
 * @param attachment - 已通过浏览器侧格式与大小检查的媒体草稿
 * @returns MIME 类型与标准 Base64 字节
 * @throws 浏览器无法读取本地文件时拒绝 Promise
 */
export async function encodeMessageAttachment(
  attachment: DraftMessageAttachment,
): Promise<MessageAttachmentUpload> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const rejectRead = (): void => reject(new Error("无法读取附件，请重新选择文件后重试"));
    reader.onerror = rejectRead;
    reader.onabort = rejectRead;
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        rejectRead();
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    };
    reader.readAsDataURL(attachment.blob);
  });
  return { mimeType: attachment.mimeType, data };
}
