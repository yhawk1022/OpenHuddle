/**
 * @module web/components/ui/message-attachment
 * @description 图片、音频与文件附件展示组件，以及应用内沉浸式 Lightbox 预览器。
 *
 * 关键视觉与性能不变量：
 * 1. 零生硬灰框与 0 CLS：常规图片（`H / W <= 2.2`）按真实宽高比贴合 `w-fit` 容器；长竖图（`H / W > 2.2`）顶部裁切预览并叠放实色半透「长图 · 查看全图」胶囊。
 * 2. 乐观双缓冲零闪烁：发送期直接渲染本地 `Blob` 缩略图并叠旋转进度胶囊；服务端确认转正后维持本地预览直至鉴权 `/attachment` 解码完毕再切换并释放 `ObjectURL`。
 * 3. 严格光学门禁：消息气泡内的角标与重试卡绝不使用 `backdrop-blur` 或 `transition-all`，保障长对话 120Hz 滚动帧率。
 */
import type { MessageDto } from "@openhuddle/protocol";
import {
  Check,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  Mic,
  RefreshCw,
  Sun,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Dialog } from "radix-ui";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { roomMessageAttachmentPath } from "../../lib/api-client.js";
import { cn } from "../../lib/cn.js";
import { formatAttachmentSize } from "../../lib/format.js";
import { canCopyImageToClipboard, copyImageUrlToClipboard } from "../../lib/message-media.js";
import { useMobileOverlayBackGuard } from "../../lib/session-store.js";
import { toast, useIsMobileViewport } from "../primitives/index.js";

/** 超长竖图 / 长流程图判定阈值（高宽比超过 2.2 时启用顶对齐窗口裁切） */
export const TALL_IMAGE_ASPECT_THRESHOLD = 2.2;

/** `ImageLightboxDialog` 入参属性 */
export interface ImageLightboxDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly src: string;
  readonly title: string;
  readonly downloadName: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly isSticker?: boolean | undefined;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
}

/**
 * 应用内全屏沉浸图片预览器：
 * - 支持适应窗口 ⇄ 原始/2× 放大细节审阅（单击/双击图片、顶栏按钮、键盘 `+` / `-` / `0`）；
 * - 放大态支持双向滚动与鼠标指针抓取平移（`cursor-grab` / `cursor-grabbing`）；
 * - 支持「切换浅色衬底」一键垫入 `#F6F8FB` 暖白画板，解决透明底黑字架构图在暗底上不可读问题；
 * - 顶栏全动作按钮保证 `>= 40×40px` 触控热区，关闭后精确归还焦点并接入移动端侧滑返回守卫。
 */
export function ImageLightboxDialog(props: ImageLightboxDialogProps) {
  const isMobile = useIsMobileViewport();
  useMobileOverlayBackGuard(props.open && isMobile, () => {
    props.onOpenChange(false);
  });

  const [zoomed, setZoomed] = useState(false);
  const [lightBackdrop, setLightBackdrop] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [copiedImage, setCopiedImage] = useState(false);
  const [naturalDims, setNaturalDims] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragSessionRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
  } | null>(null);
  const suppressClickAfterDragRef = useRef(false);
  const lastZoomToggleAtRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!props.open) {
      setZoomed(false);
      setLightBackdrop(false);
      setIsDragging(false);
      setCopiedImage(false);
      dragSessionRef.current = null;
      suppressClickAfterDragRef.current = false;
    }
  }, [props.open]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const resolvedWidth = props.width ?? naturalDims?.width;
  const resolvedHeight = props.height ?? naturalDims?.height;
  const headerMetaText =
    resolvedWidth !== undefined &&
    resolvedHeight !== undefined &&
    resolvedWidth > 0 &&
    resolvedHeight > 0
      ? `${props.title} · ${String(resolvedWidth)}×${String(resolvedHeight)}`
      : props.title;
  const canCopyImage = canCopyImageToClipboard();

  const toggleZoom = (): void => {
    lastZoomToggleAtRef.current = typeof performance !== "undefined" ? performance.now() : 0;
    setZoomed((current) => !current);
  };

  const handleCopyImage = (): void => {
    void copyImageUrlToClipboard(props.src)
      .then(() => {
        setCopiedImage(true);
        toast.success("已复制图片");
        if (copyTimerRef.current !== null) {
          window.clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = window.setTimeout(() => {
          setCopiedImage(false);
        }, 1_800);
      })
      .catch(() => {
        toast.error("复制图片失败，请尝试下载原图");
      });
  };

  const handleContentKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setZoomed(true);
    } else if (event.key === "-" || event.key === "0") {
      event.preventDefault();
      setZoomed(false);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!zoomed || event.button !== 0) {
      return;
    }
    const container = viewportRef.current;
    if (!container) {
      return;
    }
    dragSessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      moved: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const session = dragSessionRef.current;
    const container = viewportRef.current;
    if (!session || !container || session.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.moved && Math.hypot(dx, dy) > 5) {
      session.moved = true;
      setIsDragging(true);
      try {
        container.setPointerCapture(event.pointerId);
      } catch {
        // 忽略合成测试事件未注册 pointerId 的异常
      }
    }
    if (session.moved) {
      event.preventDefault();
      container.scrollLeft = session.scrollLeft - dx;
      container.scrollTop = session.scrollTop - dy;
    }
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    dragSessionRef.current = null;
    if (session.moved) {
      suppressClickAfterDragRef.current = true;
      setIsDragging(false);
      try {
        viewportRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        // 忽略释放异常
      }
      window.setTimeout(() => {
        suppressClickAfterDragRef.current = false;
      }, 0);
    }
  };

  const zoomedWidthPx =
    resolvedWidth !== undefined && resolvedWidth > 0
      ? resolvedWidth < 1200
        ? resolvedWidth * 2
        : Math.max(resolvedWidth, 1600)
      : undefined;

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-no-drag fixed inset-0 z-[105] bg-[#090A0E]/90" />
        <Dialog.Content
          onKeyDown={handleContentKeyDown}
          onCloseAutoFocus={(event) => {
            const target = props.returnFocusRef?.current;
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
          className="app-no-drag fixed inset-0 z-[106] flex flex-col justify-between outline-none"
        >
          <div className="sr-only">
            <Dialog.Title>{props.title}</Dialog.Title>
            <Dialog.Description>消息图片高清沉浸预览</Dialog.Description>
          </div>

          <header className="flex shrink-0 items-center justify-between gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top,0px))] pb-2 text-white">
            <span className="min-w-0 truncate text-xs font-medium tabular-nums text-white/85">
              {headerMetaText}
            </span>

            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              <button
                type="button"
                aria-label="切换浅色衬底"
                title="切换浅色衬底（便于阅读透明底深色线条图表）"
                aria-pressed={lightBackdrop}
                onClick={() => setLightBackdrop((v) => !v)}
                className={cn(
                  "inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none",
                  lightBackdrop
                    ? "bg-[#F6F8FB] text-[#111318] hover:bg-white"
                    : "bg-white/12 text-white hover:bg-white/22",
                )}
              >
                <Sun className="h-4 w-4" />
              </button>

              <button
                type="button"
                aria-label={zoomed ? "适应窗口" : "放大查看细节"}
                title={zoomed ? "适应窗口 (0)" : "放大查看细节 (+)"}
                aria-pressed={zoomed}
                onClick={toggleZoom}
                className={cn(
                  "inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none",
                  zoomed
                    ? "bg-white/24 text-white hover:bg-white/30"
                    : "bg-white/12 text-white hover:bg-white/22",
                )}
              >
                {zoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
              </button>

              {canCopyImage ? (
                <button
                  type="button"
                  aria-label="复制图片"
                  title="复制图片"
                  onClick={handleCopyImage}
                  className="inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
                >
                  {copiedImage ? (
                    <Check className="h-4 w-4 text-[#34D399]" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              ) : null}

              <a
                href={props.src}
                download={props.downloadName}
                aria-label="下载原图"
                title="下载原图"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
              >
                <Download className="h-4 w-4" />
              </a>

              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="关闭预览"
                  title="关闭预览 (Esc)"
                  className="inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>
          </header>

          <div
            ref={viewportRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointerDrag}
            onPointerCancel={finishPointerDrag}
            onClick={(event) => {
              if (suppressClickAfterDragRef.current) {
                return;
              }
              if (event.target === event.currentTarget) {
                props.onOpenChange(false);
              }
            }}
            onKeyDown={(event) => {
              if (
                event.target === event.currentTarget &&
                (event.key === "Enter" || event.key === " ")
              ) {
                props.onOpenChange(false);
              }
            }}
            className={cn(
              "flex min-h-0 flex-1 overflow-auto overscroll-contain p-3 pb-[max(1rem,env(safe-area-inset-bottom,0px))]",
              zoomed && (isDragging ? "cursor-grabbing select-none" : "cursor-grab select-none"),
            )}
          >
            <div
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              className={cn(
                "m-auto shrink-0",
                lightBackdrop && "rounded-xl bg-[#F6F8FB] p-3 shadow-sm",
              )}
            >
              <img
                src={props.src}
                alt={props.isSticker ? props.title : "消息原图"}
                draggable={false}
                onLoad={(event) => {
                  const { naturalWidth, naturalHeight } = event.currentTarget;
                  if (naturalWidth > 0 && naturalHeight > 0) {
                    setNaturalDims({ width: naturalWidth, height: naturalHeight });
                  }
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (suppressClickAfterDragRef.current) {
                    return;
                  }
                  const now = typeof performance !== "undefined" ? performance.now() : 0;
                  if (event.detail >= 2 && now - lastZoomToggleAtRef.current < 400) {
                    return;
                  }
                  toggleZoom();
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (suppressClickAfterDragRef.current) {
                    return;
                  }
                  const now = typeof performance !== "undefined" ? performance.now() : 0;
                  if (now - lastZoomToggleAtRef.current >= 400) {
                    toggleZoom();
                  }
                }}
                onKeyDown={(event) => event.stopPropagation()}
                style={
                  zoomed && zoomedWidthPx !== undefined
                    ? { width: `${String(zoomedWidthPx)}px` }
                    : undefined
                }
                className={cn(
                  "block rounded-lg object-contain select-none [touch-action:pinch-zoom]",
                  zoomed
                    ? cn(
                        "h-auto max-h-none max-w-none",
                        zoomedWidthPx === undefined && "w-[180vw] sm:w-[1600px]",
                        isDragging ? "cursor-grabbing" : "cursor-grab",
                      )
                    : cn(
                        "cursor-zoom-in",
                        lightBackdrop
                          ? "max-h-[calc(100dvh-7rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] max-w-[calc(100vw-3rem)]"
                          : "max-h-[calc(100dvh-5.5rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] max-w-[calc(100vw-1.5rem)]",
                      ),
                )}
              />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** `MessageAttachment` 入参属性 */
export interface MessageAttachmentProps {
  readonly message: Pick<MessageDto, "roomId" | "seq"> & {
    readonly attachment: NonNullable<MessageDto["attachment"]>;
  };
  readonly isPending: boolean;
  readonly readOnly: boolean;
  /** 是否为无正文、无引用、无提案卡的独立纯媒体气泡（独立纯图片采用 `rounded-[14px]` 贴合 `p-1` 相框） */
  readonly standalone?: boolean | undefined;
  /** 乐观发送及确认初期的客户端内存 Blob，用于 0ms 真实本地预览与零闪烁双缓冲 */
  readonly localBlob?: Blob | undefined;
  /** 可选受控 Lightbox 状态（用于右键菜单「查看大图」联动打开） */
  readonly lightboxOpen?: boolean | undefined;
  readonly onLightboxOpenChange?: ((open: boolean) => void) | undefined;
}

/**
 * 展示图片、原生音频播放器、文件下载及对应的乐观发送中与公开只读占位状态。
 * @param props - 消息标识、媒体元数据、独立相框标记与可选本地缓冲源
 * @returns 消息附件展示节点
 */
export function MessageAttachment(props: MessageAttachmentProps) {
  const [failed, setFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [internalLightboxOpen, setInternalLightboxOpen] = useState(false);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [remoteLoadedForSrc, setRemoteLoadedForSrc] = useState<string | null>(null);
  const [localLoaded, setLocalLoaded] = useState(false);
  const [measuredDims, setMeasuredDims] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const lightboxOpen = props.lightboxOpen ?? internalLightboxOpen;
  const setLightboxOpen = (nextOpen: boolean): void => {
    setInternalLightboxOpen(nextOpen);
    props.onLightboxOpenChange?.(nextOpen);
  };

  const { message } = props;
  const { mimeType, stickerName, fileName, byteLength, width, height } = message.attachment;
  const isImage = mimeType.startsWith("image/");
  const isFile = mimeType === "application/octet-stream";
  const isSticker = stickerName !== undefined;
  const label = isSticker ? `表情：${stickerName}` : isImage ? "图片" : "语音";

  const baseSrc = roomMessageAttachmentPath(message.roomId, message.seq);
  const remoteSrc =
    retryNonce > 0
      ? `${baseSrc}${baseSrc.includes("?") ? "&" : "?"}retry=${String(retryNonce)}`
      : baseSrc;
  const isRemoteLoaded = remoteLoadedForSrc === remoteSrc;

  // 本地双缓冲生命周期：在乐观挂起及正式 /attachment 解码完成前持续持有 blob URL，解码完成当帧释放
  useEffect(() => {
    if (props.localBlob === undefined || props.readOnly || isFile || isRemoteLoaded) {
      setLocalUrl(null);
      setLocalLoaded(false);
      return;
    }
    const source =
      props.localBlob.type === mimeType
        ? props.localBlob
        : props.localBlob.slice(0, props.localBlob.size, mimeType);
    const objectUrl = URL.createObjectURL(source);
    setLocalUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [props.localBlob, props.readOnly, isFile, isRemoteLoaded, mimeType]);

  // ── 1. 公开只读分享页隔离态：渲染安静的凹陷媒体占位小条 ──
  if (props.readOnly) {
    const readOnlyLabel = isImage
      ? "图片附件（仅群成员可见）"
      : isFile
        ? "文件附件（仅群成员可见）"
        : "语音消息（仅群成员可见）";
    return (
      <div
        className={cn(
          props.standalone ? "" : "mt-1.5",
          "inline-flex max-w-full select-none items-center gap-1.5 rounded-[10px] bg-black/[0.04] px-2.5 py-1.5 text-xs text-[#545D6C] ring-1 ring-inset ring-black/[0.06] dark:bg-[#141417]/85 dark:text-[#9898A2] dark:ring-white/[0.08]",
        )}
      >
        {isImage ? (
          <ImageIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-80" />
        ) : isFile ? (
          <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-80" />
        ) : (
          <Mic aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-80" />
        )}
        <span className="truncate">{readOnlyLabel}</span>
      </div>
    );
  }

  // ── 2. 通用下载文件附件 ──
  if (isFile) {
    const name = fileName ?? "附件";
    if (props.isPending) {
      return (
        <div
          className={cn(
            props.standalone ? "" : "mt-1.5",
            "flex w-fit max-w-full items-center gap-2 rounded-lg bg-black/[0.035] px-2.5 py-1.5 opacity-85 dark:bg-white/[0.06]",
          )}
        >
          <FileText aria-hidden="true" className="h-5 w-5 shrink-0" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{name}</span>
            <span className="block text-xs text-[#687082] dark:text-[#C4C4CA]">
              {formatAttachmentSize(byteLength)}
            </span>
          </span>
          <Loader2 aria-hidden="true" className="ml-1 h-4 w-4 shrink-0 animate-spin" />
        </div>
      );
    }
    return (
      <a
        href={remoteSrc}
        download={name}
        aria-label={`下载文件 ${name}`}
        title={name}
        className={cn(
          props.standalone ? "" : "mt-1.5",
          "flex w-fit max-w-full items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-black/[0.05] focus-visible:ring-2 dark:hover:bg-white/[0.08]",
        )}
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

  // ── 3. 图片与表情消息（含自适应比例容器、长图裁切、双缓冲零闪烁与凹陷重试卡） ──
  if (isImage) {
    const imageRadiusClass = isSticker
      ? "rounded-lg"
      : props.standalone
        ? "rounded-[14px]"
        : "mt-2 rounded-[12px]";

    if (!props.isPending && failed && localUrl === null) {
      return (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setFailed(false);
            setRetryNonce((n) => n + 1);
          }}
          className={cn(
            imageRadiusClass,
            "app-no-drag flex min-h-[6.5rem] w-[min(100%,15.5rem)] cursor-pointer flex-col items-center justify-center gap-1.5 bg-black/[0.04] px-4 py-3.5 text-center text-xs font-medium text-[#545D6C] ring-1 ring-inset ring-black/[0.06] transition-colors hover:bg-black/[0.065] hover:text-[#111318] focus-visible:ring-2 dark:bg-[#141417]/85 dark:text-[#9898A2] dark:ring-white/[0.08] dark:hover:bg-white/[0.07] dark:hover:text-[#F2F2F4]",
          )}
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4 text-[#687082] dark:text-[#8E8E96]" />
          <span>{isSticker ? "表情加载失败 · 点击重试" : "图片加载失败 · 点击重试"}</span>
        </button>
      );
    }

    const resolvedWidth = width ?? measuredDims?.width;
    const resolvedHeight = height ?? measuredDims?.height;
    const hasKnownDims =
      resolvedWidth !== undefined &&
      resolvedHeight !== undefined &&
      resolvedWidth > 0 &&
      resolvedHeight > 0;
    const isTallImage =
      !isSticker && hasKnownDims && resolvedHeight / resolvedWidth > TALL_IMAGE_ASPECT_THRESHOLD;

    const displaySrc = props.isPending
      ? localUrl
      : localUrl !== null && !isRemoteLoaded
        ? localUrl
        : remoteSrc;
    const shouldPreloadRemote = !props.isPending && localUrl !== null && !isRemoteLoaded;
    const isDisplayLoaded =
      displaySrc !== null && (displaySrc === localUrl ? localLoaded : isRemoteLoaded);
    const downloadName = fileName ?? `openhuddle-image-${String(message.seq)}`;
    const previewTitle = isSticker ? label : (fileName ?? "消息图片");

    const handleImageLoad = (el: HTMLImageElement, isFromRemote: boolean): void => {
      if (el.naturalWidth > 0 && el.naturalHeight > 0) {
        setMeasuredDims({ width: el.naturalWidth, height: el.naturalHeight });
      }
      if (isFromRemote) {
        setRemoteLoadedForSrc(remoteSrc);
      } else {
        setLocalLoaded(true);
      }
    };

    const statusBadge = props.isPending ? (
      <span
        aria-label="图片发送中"
        className="pointer-events-none absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full bg-[#181B22]/68 px-2 py-0.5 text-[11px] font-medium text-white"
      >
        <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
        <span>发送中</span>
      </span>
    ) : isTallImage ? (
      <span className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-[#181B22]/76 px-2 py-0.5 text-[11px] font-medium text-white">
        长图 · 查看全图
      </span>
    ) : null;

    const remotePreloader = shouldPreloadRemote ? (
      <img
        src={remoteSrc}
        decoding="async"
        alt=""
        aria-hidden="true"
        onLoad={(event) => {
          const el = event.currentTarget;
          const commitSwap = (): void => handleImageLoad(el, true);
          if (typeof el.decode === "function") {
            el.decode().then(commitSwap, commitSwap);
          } else {
            commitSwap();
          }
        }}
        className="pointer-events-none absolute h-0 w-0 opacity-0"
      />
    ) : null;

    if (isSticker) {
      return (
        <>
          <button
            ref={triggerRef}
            type="button"
            disabled={displaySrc === null}
            onClick={(event) => {
              event.stopPropagation();
              if (displaySrc !== null) {
                setLightboxOpen(true);
              }
            }}
            aria-label={`查看原图：${previewTitle}`}
            className={cn(
              props.standalone ? "" : "mt-1",
              "app-no-drag relative block aspect-square w-28 max-w-full cursor-zoom-in rounded-lg focus-visible:ring-2 sm:w-32",
            )}
          >
            {displaySrc !== null ? (
              <img
                src={displaySrc}
                loading={props.isPending ? "eager" : "lazy"}
                decoding="async"
                alt={label}
                onLoad={(e) => handleImageLoad(e.currentTarget, displaySrc === remoteSrc)}
                onError={() => {
                  if (displaySrc === remoteSrc) {
                    setFailed(true);
                  }
                }}
                className="block h-full w-full object-contain"
              />
            ) : (
              <span
                aria-hidden="true"
                className="block h-full w-full animate-pulse rounded-lg bg-black/[0.05] dark:bg-white/[0.07]"
              />
            )}
            {remotePreloader}
            {statusBadge}
          </button>

          {displaySrc !== null ? (
            <ImageLightboxDialog
              open={lightboxOpen}
              onOpenChange={setLightboxOpen}
              src={isRemoteLoaded ? remoteSrc : displaySrc}
              title={previewTitle}
              downloadName={downloadName}
              width={resolvedWidth}
              height={resolvedHeight}
              isSticker={true}
              returnFocusRef={triggerRef}
            />
          ) : null}
        </>
      );
    }

    if (isTallImage) {
      return (
        <>
          <button
            ref={triggerRef}
            type="button"
            disabled={displaySrc === null}
            onClick={(event) => {
              event.stopPropagation();
              if (displaySrc !== null) {
                setLightboxOpen(true);
              }
            }}
            aria-label={`查看原图：${previewTitle}`}
            className={cn(
              imageRadiusClass,
              "app-no-drag relative block h-64 w-[min(100%,15rem)] cursor-zoom-in overflow-hidden ring-1 ring-inset ring-black/[0.06] focus-visible:ring-2 after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-black/[0.06] sm:h-72 sm:w-[min(100%,17rem)] dark:ring-white/[0.08] dark:after:ring-white/[0.08]",
              !isDisplayLoaded && "bg-black/[0.035] dark:bg-white/[0.05]",
            )}
          >
            {displaySrc !== null ? (
              <img
                src={displaySrc}
                width={resolvedWidth}
                height={resolvedHeight}
                loading={props.isPending ? "eager" : "lazy"}
                decoding="async"
                alt={previewTitle}
                onLoad={(e) => handleImageLoad(e.currentTarget, displaySrc === remoteSrc)}
                onError={() => {
                  if (displaySrc === remoteSrc) {
                    setFailed(true);
                  }
                }}
                className="block h-full w-full object-cover object-top"
              />
            ) : (
              <span
                aria-hidden="true"
                className="block h-full w-full animate-pulse bg-black/[0.05] dark:bg-white/[0.07]"
              />
            )}
            {remotePreloader}
            {statusBadge}
          </button>

          {displaySrc !== null ? (
            <ImageLightboxDialog
              open={lightboxOpen}
              onOpenChange={setLightboxOpen}
              src={isRemoteLoaded ? remoteSrc : displaySrc}
              title={previewTitle}
              downloadName={downloadName}
              width={resolvedWidth}
              height={resolvedHeight}
              returnFocusRef={triggerRef}
            />
          ) : null}
        </>
      );
    }

    const showLegacySkeleton = !hasKnownDims && !isDisplayLoaded;

    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          disabled={displaySrc === null}
          onClick={(event) => {
            event.stopPropagation();
            if (displaySrc !== null) {
              setLightboxOpen(true);
            }
          }}
          aria-label={`查看原图：${previewTitle}`}
          className={cn(
            imageRadiusClass,
            "app-no-drag relative block max-h-[18rem] w-fit max-w-[min(100%,17.5rem)] cursor-zoom-in overflow-hidden ring-1 ring-inset ring-black/[0.06] focus-visible:ring-2 after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-black/[0.06] sm:max-h-[22rem] sm:max-w-[min(100%,26rem)] dark:ring-white/[0.08] dark:after:ring-white/[0.08]",
            hasKnownDims && !isDisplayLoaded && "bg-black/[0.035] dark:bg-white/[0.05]",
          )}
        >
          {showLegacySkeleton ? (
            <span
              aria-hidden="true"
              className="block h-36 w-52 max-w-full animate-pulse bg-black/[0.05] dark:bg-white/[0.07]"
            />
          ) : displaySrc === null && hasKnownDims ? (
            <span
              aria-hidden="true"
              style={{
                aspectRatio: `${String(resolvedWidth)} / ${String(resolvedHeight)}`,
                width: `${String(Math.min(resolvedWidth, 320))}px`,
              }}
              className="block max-h-[inherit] max-w-full animate-pulse bg-black/[0.05] dark:bg-white/[0.07]"
            />
          ) : null}

          {displaySrc !== null ? (
            <img
              src={displaySrc}
              width={resolvedWidth}
              height={resolvedHeight}
              style={
                hasKnownDims
                  ? { aspectRatio: `${String(resolvedWidth)} / ${String(resolvedHeight)}` }
                  : undefined
              }
              loading={props.isPending ? "eager" : "lazy"}
              decoding="async"
              alt={previewTitle}
              onLoad={(e) => handleImageLoad(e.currentTarget, displaySrc === remoteSrc)}
              onError={() => {
                if (displaySrc === remoteSrc) {
                  setFailed(true);
                }
              }}
              className={cn(
                "block h-auto w-auto max-h-[inherit] max-w-full object-contain ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.08]",
                showLegacySkeleton && "pointer-events-none absolute inset-0 h-0 w-0 opacity-0",
              )}
            />
          ) : null}
          {remotePreloader}
          {statusBadge}
        </button>

        {displaySrc !== null ? (
          <ImageLightboxDialog
            open={lightboxOpen}
            onOpenChange={setLightboxOpen}
            src={isRemoteLoaded ? remoteSrc : displaySrc}
            title={previewTitle}
            downloadName={downloadName}
            width={resolvedWidth}
            height={resolvedHeight}
            returnFocusRef={triggerRef}
          />
        ) : null}
      </>
    );
  }

  // ── 4. 语音消息播放器与失败重试 ──
  if (!props.isPending && failed) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setFailed(false);
          setRetryNonce((n) => n + 1);
        }}
        className={cn(
          props.standalone ? "" : "mt-1.5",
          "app-no-drag inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] bg-black/[0.04] px-3 py-2 text-xs font-medium text-[#545D6C] ring-1 ring-inset ring-black/[0.06] transition-colors hover:bg-black/[0.065] hover:text-[#111318] focus-visible:ring-2 dark:bg-[#141417]/85 dark:text-[#9898A2] dark:ring-white/[0.08] dark:hover:bg-white/[0.07] dark:hover:text-[#F2F2F4]",
        )}
      >
        <RefreshCw aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span>语音加载失败 · 点击重试</span>
      </button>
    );
  }

  if (props.isPending && localUrl === null) {
    return (
      <div
        className={cn(
          props.standalone ? "" : "mt-1.5",
          "inline-flex items-center gap-1.5 rounded-[10px] bg-black/[0.04] px-3 py-2 text-xs text-[#687082] dark:bg-white/[0.06] dark:text-[#C4C4CA]",
        )}
      >
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
        <span>语音发送中…</span>
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/useMediaCaption: 房间成员发送的语音没有字幕轨，播放和进度由原生控件提供。
    <audio
      src={props.isPending && localUrl !== null ? localUrl : remoteSrc}
      controls
      preload="none"
      aria-label="播放语音消息"
      onError={() => {
        if (!props.isPending) {
          setFailed(true);
        }
      }}
      className={cn(
        props.standalone ? "" : "mt-1.5",
        "block h-10 w-[min(17rem,66vw)] max-w-full sm:w-72",
      )}
    />
  );
}
