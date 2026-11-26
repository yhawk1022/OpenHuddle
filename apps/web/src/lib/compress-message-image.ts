/**
 * @module web/lib/compress-message-image
 * @description 将超限图片在浏览器本地重新编码，上传和预览共用压缩结果。
 */
import { MAX_MESSAGE_ATTACHMENT_BYTES } from "@openhuddle/protocol";

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const TARGET_LONG_EDGES = [2560, 2048, 1536, 1024];

/**
 * 为超过服务器上限的图片生成可发送的静态副本。
 * @param source - 已确认是支持格式的本地图片
 * @param signal - 选图被替换或离开输入框时取消后续编码
 * @returns 可直接预览和发送的图片数据及实际 MIME 类型
 * @throws 图片过大、无法解码或编码失败时抛出
 */
export async function compressMessageImage(
  source: Blob,
  signal: AbortSignal,
): Promise<{
  readonly blob: Blob;
  readonly mimeType: "image/jpeg" | "image/webp" | "image/png";
  readonly width: number;
  readonly height: number;
}> {
  signal.throwIfAborted();
  if (source.size > MAX_SOURCE_BYTES) {
    throw new Error("原图超过 64 MB，请缩小原图后重试");
  }

  const sourceUrl = URL.createObjectURL(source);
  const canvas = document.createElement("canvas");
  try {
    const image = new Image();
    image.src = sourceUrl;
    await image.decode();
    signal.throwIfAborted();
    const { naturalWidth: width, naturalHeight: height } = image;
    const context = canvas.getContext("2d");
    if (context === null || width === 0 || height === 0) {
      throw new Error("浏览器无法压缩这张图片");
    }

    // JPEG 沿用高质量 JPEG，其他图片优先选保留透明通道的 WebP；对原图尺寸小于目标边长的档位去重避免重复编码
    const requestedType = source.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    const maxDim = Math.max(width, height);
    const uniqueScales = Array.from(
      new Set(TARGET_LONG_EDGES.map((longEdge) => Math.min(1, longEdge / maxDim))),
    );

    for (const scale of uniqueScales) {
      signal.throwIfAborted();
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, requestedType, 0.9),
      );
      signal.throwIfAborted();
      // 浏览器不支持指定格式时可能返回 PNG，以实际的编码结果为准。
      if (
        blob !== null &&
        blob.size > 0 &&
        blob.size <= MAX_MESSAGE_ATTACHMENT_BYTES &&
        (blob.type === "image/jpeg" || blob.type === "image/webp" || blob.type === "image/png")
      ) {
        return { blob, mimeType: blob.type, width: canvas.width, height: canvas.height };
      }
    }
    throw new Error("无法把图片压缩到 8 MB 以内，请换一张图片");
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    URL.revokeObjectURL(sourceUrl);
  }
}
