/**
 * @module web/components/ui/message-attachment
 * @description 图片、音频和下载附件展示。附件由浏览器通过同源鉴权端点按需读取。
 */
import type { MessageDto } from "@openhuddle/protocol";
import { Download, FileText } from "lucide-react";
import { useState } from "react";
import { roomMessageAttachmentPath } from "../../lib/api-client.js";
import { formatAttachmentSize } from "../../lib/format.js";

/**
 * 展示图片、原生音频播放器、文件下载及对应的发送中状态。
 * @param props - 消息标识、媒体元数据以及是否允许就地读取
 * @returns 消息附件独立展示节点
 */
export function MessageAttachment(props: {
  readonly message: Pick<MessageDto, "roomId" | "seq"> & {
    readonly attachment: NonNullable<MessageDto["attachment"]>;
  };
  readonly isPending: boolean;
  readonly readOnly: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const { message } = props;
  const { mimeType, stickerName, fileName, byteLength } = message.attachment;
  const isImage = mimeType.startsWith("image/");
  const isFile = mimeType === "application/octet-stream";
  const label = stickerName !== undefined ? `表情：${stickerName}` : isImage ? "图片" : "语音";
  const className = "mt-1 block text-xs text-[#687082] dark:text-[#C4C4CA]";

  if (props.isPending || props.readOnly) {
    return <span className={className}>{isFile ? (fileName ?? "附件") : label}</span>;
  }

  const src = roomMessageAttachmentPath(message.roomId, message.seq);
  if (isFile) {
    const name = fileName ?? "附件";
    return (
      <a
        href={src}
        download={name}
        aria-label={`下载文件 ${name}`}
        title={name}
        className="mt-1 flex w-fit max-w-full items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-black/[0.05] focus-visible:ring-2 dark:hover:bg-white/[0.08]"
      >
        <FileText aria-hidden="true" className="h-5 w-5 shrink-0" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block text-xs text-[#687082] dark:text-[#C4C4CA]">
            {formatAttachmentSize(byteLength)}
          </span>
        </span>
        <Download aria-hidden="true" className="ml-1 h-4 w-4 shrink-0" />
      </a>
    );
  }
  if (failed) {
    return (
      <button type="button" onClick={() => setFailed(false)} className={`${className} underline`}>
        {stickerName !== undefined ? "表情" : label}加载失败，重试
      </button>
    );
  }

  if (isImage) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        title="查看原图（在新窗口打开）"
        className={
          stickerName !== undefined
            ? "mt-1 block aspect-square w-28 max-w-full rounded-lg focus-visible:ring-2 sm:w-32"
            : "mt-1 block h-40 w-60 max-w-full overflow-hidden rounded-lg bg-black/[0.04] focus-visible:ring-2 sm:h-52 sm:w-72 dark:bg-white/[0.06]"
        }
      >
        <img
          src={src}
          loading="lazy"
          decoding="async"
          alt={stickerName !== undefined ? label : "消息图片"}
          onError={() => setFailed(true)}
          className="block h-full w-full object-contain"
        />
      </a>
    );
  }

  return (
    // biome-ignore lint/a11y/useMediaCaption: 房间成员发送的语音没有字幕轨，播放和进度由原生控件提供。
    <audio
      src={src}
      controls
      preload="none"
      aria-label="播放语音消息"
      onError={() => setFailed(true)}
      className="mt-1 block h-10 w-72 max-w-full"
    />
  );
}
