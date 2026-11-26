/**
 * @module web/lib/message-media
 * @description 浏览器消息附件本地草稿、文件名清洗、传输编码与图片剪贴板复制。原始文件在用户发送前只保留在组件内存中。
 */
import {
  MessageAttachmentFileNameSchema,
  type MessageAttachmentMimeType,
  type MessageAttachmentUpload,
} from "@openhuddle/protocol";

/** 待提交的媒体草稿，保留原始字节以免在交互期间重复编码。 */
export interface DraftMessageAttachment {
  readonly blob: Blob;
  readonly mimeType: MessageAttachmentMimeType;
  readonly name: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly wasCompressed?: true;
  readonly stickerName?: string;
}

/**
 * 清洗并校验附件文件名，确保满足协议 `MessageAttachmentFileNameSchema`。
 * @param rawName - 浏览器 File 对象提供的原始文件名
 * @returns 合规文件名；无法清洗为非空合法文件名时返回 `undefined`
 */
export function sanitizeAttachmentFileName(rawName: string): string | undefined {
  const direct = MessageAttachmentFileNameSchema.safeParse(rawName);
  if (direct.success) {
    return direct.data;
  }
  const baseName = rawName.split(/[/\\]/u).pop() ?? rawName;
  const cleaned = baseName
    .replace(/[/\\\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/gu, "")
    .trim()
    .slice(0, 255);
  const parsed = MessageAttachmentFileNameSchema.safeParse(cleaned);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 生成输入舱草稿预览条的可读文件名（将浏览器剪贴板默认的匿名 `image.png` 映射为 `剪贴板图片.png`）。
 */
export function formatDraftAttachmentDisplayName(
  attachment: Pick<DraftMessageAttachment, "name" | "mimeType" | "stickerName">,
): string {
  const trimmed = attachment.name.trim();
  if (
    attachment.mimeType.startsWith("image/") &&
    attachment.stickerName === undefined &&
    /^image\.(png|jpe?g|webp|gif)$/iu.test(trimmed)
  ) {
    return trimmed.replace(/^image\./iu, "剪贴板图片.");
  }
  return trimmed.length > 0 ? trimmed : "附件";
}

/**
 * 检测当前浏览器上下文是否支持写入二进制图片剪贴板（`ClipboardItem` + `navigator.clipboard.write`）。
 */
export function canCopyImageToClipboard(): boolean {
  return (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  );
}

async function decodeBlobToPngBlob(sourceBlob: Blob): Promise<Blob> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return sourceBlob;
  }
  const objectUrl = URL.createObjectURL(sourceBlob);
  const canvas = document.createElement("canvas");
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("无法解码图片"));
      img.src = objectUrl;
    });
    const width = Math.max(1, img.naturalWidth || img.width || 1);
    const height = Math.max(1, img.naturalHeight || img.height || 1);
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      if (sourceBlob.type === "image/png") {
        return sourceBlob;
      }
      throw new Error("当前浏览器不支持画布转换");
    }
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0, width, height);
    const pngBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (pngBlob === null) {
      throw new Error("无法将图片转换为 PNG");
    }
    return pngBlob;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * 拉取指定图片地址并经由 Canvas 统一转为 `image/png` 写入系统剪贴板。
 * @param src - 同源鉴权附件地址或本地 `blob:` 预览地址
 */
export async function copyImageUrlToClipboard(src: string): Promise<void> {
  if (!canCopyImageToClipboard()) {
    throw new Error("当前浏览器不支持复制图片");
  }
  const pngPromise = (async (): Promise<Blob> => {
    const response = await fetch(src, { credentials: "include" });
    if (!response.ok) {
      throw new Error("拉取原图失败");
    }
    const rawBlob = await response.blob();
    return decodeBlobToPngBlob(rawBlob);
  })();

  try {
    // 优先向 ClipboardItem 直接传入 Promise<Blob>，保留 Safari / WebKit 瞬态用户手势激活态
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngPromise })]);
  } catch (err) {
    if (err instanceof TypeError) {
      const resolvedBlob = await pngPromise;
      await navigator.clipboard.write([new ClipboardItem({ "image/png": resolvedBlob })]);
      return;
    }
    throw err;
  }
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

  const resolvedFileName =
    attachment.mimeType === "application/octet-stream"
      ? attachment.name
      : attachment.mimeType.startsWith("image/") && attachment.stickerName === undefined
        ? sanitizeAttachmentFileName(attachment.name)
        : undefined;

  return {
    mimeType: attachment.mimeType,
    data,
    ...(attachment.stickerName !== undefined ? { stickerName: attachment.stickerName } : {}),
    ...(resolvedFileName !== undefined ? { fileName: resolvedFileName } : {}),
  };
}
