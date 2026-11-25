/**
 * @module web/components/ui/message-attachment
 * @description 图片、音频和下载附件展示。图片采用应用内沉浸式 Lightbox 预览，避免 Standalone PWA 与内置 WebView 跳出聊天窗口。
 */
import type { MessageDto } from "@openhuddle/protocol";
import { Download, FileText, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { roomMessageAttachmentPath } from "../../lib/api-client.js";
import { formatAttachmentSize } from "../../lib/format.js";
import { useMobileOverlayBackGuard } from "../../lib/session-store.js";
import { useIsMobileViewport } from "../primitives/index.js";

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
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const isMobile = useIsMobileViewport();
  useMobileOverlayBackGuard(lightboxOpen && isMobile, () => {
    setLightboxOpen(false);
  });

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
    const downloadName = fileName ?? `openhuddle-image-${String(message.seq)}`;
    return (
      <>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setLightboxOpen(true);
          }}
          aria-label={`查看原图：${stickerName !== undefined ? label : (fileName ?? "消息图片")}`}
          className={
            stickerName !== undefined
              ? "mt-1 block aspect-square w-28 max-w-full cursor-zoom-in rounded-lg focus-visible:ring-2 sm:w-32"
              : "mt-1 block h-40 w-60 max-w-full cursor-zoom-in overflow-hidden rounded-lg bg-black/[0.04] focus-visible:ring-2 sm:h-52 sm:w-72 dark:bg-white/[0.06]"
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
        </button>

        <Dialog.Root open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="app-no-drag fixed inset-0 z-[105] bg-[#090A0E]/88" />
            <Dialog.Content className="app-no-drag fixed inset-0 z-[106] flex flex-col justify-between outline-none">
              <div className="sr-only">
                <Dialog.Title>{fileName ?? label}</Dialog.Title>
                <Dialog.Description>消息图片高清预览</Dialog.Description>
              </div>
              <header className="flex shrink-0 items-center justify-between gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top,0px))] pb-2 text-white">
                <span className="min-w-0 truncate text-xs font-medium text-white/80">
                  {fileName ?? label}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <a
                    href={src}
                    download={downloadName}
                    aria-label="下载原图"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/12 text-white transition hover:bg-white/22"
                  >
                    <Download className="h-4 w-4" />
                  </a>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="关闭预览"
                      className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-white/12 text-white transition hover:bg-white/22"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </Dialog.Close>
                </div>
              </header>

              <div
                onClick={() => setLightboxOpen(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    setLightboxOpen(false);
                  }
                }}
                className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3 pb-[max(1rem,env(safe-area-inset-bottom,0px))]"
              >
                <img
                  src={src}
                  alt={stickerName !== undefined ? label : "消息原图"}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="max-h-full max-w-full rounded-lg object-contain select-none [touch-action:pinch-zoom]"
                />
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </>
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
      className="mt-1 block h-10 w-[min(17rem,66vw)] max-w-full sm:w-72"
    />
  );
}
