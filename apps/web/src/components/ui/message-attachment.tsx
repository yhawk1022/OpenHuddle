/**
 * @module web/components/ui/message-attachment
 * @description 消息媒体展示。已提交的媒体由浏览器按需读取同源鉴权端点，公开回放只显示附件类型。
 */
import type { MessageDto } from "@openhuddle/protocol";
import { useState } from "react";
import { roomMessageAttachmentPath } from "../../lib/api-client.js";

/**
 * 展示图片、原生音频播放器，或对应的发送中及获取失败状态。
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
  const isImage = message.attachment.mimeType.startsWith("image/");
  const label = isImage ? "图片" : "语音";
  const className = "mt-1 block text-xs text-[#687082] dark:text-[#C4C4CA]";

  if (props.isPending || props.readOnly) {
    return <span className={className}>{label}</span>;
  }
  if (failed) {
    return (
      <button type="button" onClick={() => setFailed(false)} className={`${className} underline`}>
        {label}加载失败，重试
      </button>
    );
  }

  const src = roomMessageAttachmentPath(message.roomId, message.seq);
  if (isImage) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        title="查看原图（在新窗口打开）"
        className="mt-1 block h-40 w-60 max-w-full overflow-hidden rounded-lg bg-black/[0.04] focus-visible:ring-2 sm:h-52 sm:w-72 dark:bg-white/[0.06]"
      >
        <img
          src={src}
          loading="lazy"
          decoding="async"
          alt="消息图片"
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
