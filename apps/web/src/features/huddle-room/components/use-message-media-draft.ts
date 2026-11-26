/**
 * @module web/features/huddle-room/use-message-media-draft
 * @description 消息附件选择与麦克风采集。房间切换或取消录音时释放设备，迟到的授权结果不能写入新草稿。
 */
import {
  MAX_MESSAGE_ATTACHMENT_BYTES,
  MessageAttachmentFileNameSchema,
  type MessageAttachmentMimeType,
  MessageAttachmentMimeTypeSchema,
} from "@openhuddle/protocol";
import { useEffect, useRef, useState } from "react";
import { compressMessageImage } from "../../../lib/compress-message-image.js";
import type { DraftMessageAttachment } from "../../../lib/message-media.js";
import type { StickerImage } from "../stickers/sticker-library.js";

const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
const SIZE_LIMIT_TEXT = `附件大小上限为 ${String(MAX_MESSAGE_ATTACHMENT_BYTES / 1024 / 1024)} MB`;
const MIME_BY_EXTENSION: Readonly<Record<string, MessageAttachmentMimeType>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  webm: "audio/webm",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

type RecordingPhase = "idle" | "requesting" | "recording" | "finishing";

interface RecordingSession {
  readonly chunks: Blob[];
  byteLength: number;
  stream?: MediaStream;
  recorder?: MediaRecorder;
}

function normalizeMimeType(type: string): MessageAttachmentMimeType | undefined {
  const mime = type.split(";", 1)[0]?.trim().toLowerCase();
  switch (mime) {
    case "audio/x-wav":
    case "audio/wave":
      return "audio/wav";
    case "audio/x-m4a":
      return "audio/mp4";
    case "application/ogg":
      return "audio/ogg";
    default: {
      const parsed = MessageAttachmentMimeTypeSchema.safeParse(mime);
      return parsed.success ? parsed.data : undefined;
    }
  }
}

function readFileMimeType(file: File): MessageAttachmentMimeType {
  const mimeType = normalizeMimeType(file.type);
  if (mimeType !== undefined && mimeType !== "application/octet-stream") {
    return mimeType;
  }
  const extension = /\.([a-z0-9]+)$/iu.exec(file.name)?.[1]?.toLowerCase();
  // 文件选择器可能把纯音频 WebM/M4A 标为容器类型，最终仍由服务端校验文件字节。
  if (
    extension !== undefined &&
    (file.type === "" ||
      file.type === "application/octet-stream" ||
      (extension === "webm" && file.type === "video/webm") ||
      (extension === "m4a" && file.type === "video/mp4"))
  ) {
    return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
  }
  return "application/octet-stream";
}

function releaseRecording(session: RecordingSession): void {
  if (session.recorder && session.recorder.state !== "inactive") {
    session.recorder.stop();
  }
  for (const track of session.stream?.getTracks() ?? []) {
    track.stop();
  }
}

/** 管理单个输入框的媒体草稿、录音状态与设备生命周期。 */
export function useMessageMediaDraft() {
  const [attachment, setAttachment] = useState<DraftMessageAttachment | null>(null);
  const [phase, setPhase] = useState<RecordingPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isPreparingImage, setIsPreparingImage] = useState(false);
  const imageSelectionRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<RecordingSession | null>(null);
  const canRecord =
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";

  useEffect(
    () => () => {
      imageSelectionRef.current?.abort();
      const current = sessionRef.current;
      sessionRef.current = null;
      if (current !== null) {
        releaseRecording(current);
      }
    },
    [],
  );

  const clearAttachment = (expected?: DraftMessageAttachment): void => {
    setAttachment((current) => (expected === undefined || current === expected ? null : current));
    setError(null);
  };

  const restoreAttachment = (draftAttachment: DraftMessageAttachment): void => {
    setAttachment((current) => current ?? draftAttachment);
    setError(null);
  };

  const chooseFiles = async (files: readonly File[]): Promise<void> => {
    const file = files[0];
    if (file === undefined) {
      return;
    }
    if (files.length > 1) {
      setError("每条消息可带一个附件，请分开发送");
      return;
    }
    imageSelectionRef.current?.abort();
    imageSelectionRef.current = null;
    setIsPreparingImage(false);
    const mimeType = readFileMimeType(file);
    if (
      file.size === 0 ||
      (file.size > MAX_MESSAGE_ATTACHMENT_BYTES && !mimeType.startsWith("image/"))
    ) {
      setError(file.size === 0 ? "无法发送空文件" : SIZE_LIMIT_TEXT);
      return;
    }
    setError(null);
    if (mimeType === "application/octet-stream") {
      const name = MessageAttachmentFileNameSchema.safeParse(file.name.trim() || "附件");
      if (!name.success) {
        setError("无法使用此文件名，请重命名后再发送");
        return;
      }
      setAttachment({ blob: file, mimeType, name: name.data });
      return;
    }
    if (file.size <= MAX_MESSAGE_ATTACHMENT_BYTES) {
      const initialDraft: DraftMessageAttachment = { blob: file, mimeType, name: file.name };
      setAttachment(initialDraft);
      if (
        mimeType.startsWith("image/") &&
        typeof Image !== "undefined" &&
        typeof URL.createObjectURL === "function"
      ) {
        const probeSelection = new AbortController();
        imageSelectionRef.current = probeSelection;
        const probeUrl = URL.createObjectURL(file);
        const probeImg = new Image();
        probeImg.onload = () => {
          URL.revokeObjectURL(probeUrl);
          if (
            !probeSelection.signal.aborted &&
            probeImg.naturalWidth > 0 &&
            probeImg.naturalHeight > 0
          ) {
            setAttachment((current) =>
              current === initialDraft
                ? {
                    ...current,
                    width: probeImg.naturalWidth,
                    height: probeImg.naturalHeight,
                  }
                : current,
            );
          }
        };
        probeImg.onerror = () => {
          URL.revokeObjectURL(probeUrl);
        };
        probeImg.src = probeUrl;
      }
      return;
    }

    const selection = new AbortController();
    imageSelectionRef.current = selection;
    setIsPreparingImage(true);
    try {
      const compressed = await compressMessageImage(file, selection.signal);
      if (!selection.signal.aborted) {
        setAttachment({ ...compressed, name: file.name, wasCompressed: true });
      }
    } catch (cause) {
      if (!selection.signal.aborted) {
        setError(
          cause instanceof DOMException || !(cause instanceof Error)
            ? "无法读取这张图片，请重新选择"
            : cause.message,
        );
      }
    } finally {
      // 老选图完成时不覆盖后来的选图或离开房间后的草稿。
      if (!selection.signal.aborted) {
        imageSelectionRef.current = null;
        setIsPreparingImage(false);
      }
    }
  };

  const chooseSticker = ({ blob, mimeType, name }: StickerImage): void => {
    imageSelectionRef.current?.abort();
    imageSelectionRef.current = null;
    setIsPreparingImage(false);
    setAttachment({ blob, mimeType, name, stickerName: name });
    setError(null);
  };

  const cancelRecording = (): void => {
    const current = sessionRef.current;
    sessionRef.current = null;
    if (current !== null) {
      releaseRecording(current);
    }
    setPhase("idle");
  };

  const startRecording = async (): Promise<void> => {
    if (!canRecord || sessionRef.current !== null) {
      return;
    }
    const session: RecordingSession = { chunks: [], byteLength: 0 };
    sessionRef.current = session;
    setError(null);
    setPhase("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      session.stream = stream;
      if (sessionRef.current !== session) {
        releaseRecording(session);
        return;
      }

      const preferredMimeType = RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, {
        audioBitsPerSecond: 64_000,
        ...(preferredMimeType !== undefined ? { mimeType: preferredMimeType } : {}),
      });
      session.recorder = recorder;
      recorder.ondataavailable = ({ data }) => {
        if (sessionRef.current !== session || data.size === 0) {
          return;
        }
        session.byteLength += data.size;
        if (session.byteLength > MAX_MESSAGE_ATTACHMENT_BYTES) {
          cancelRecording();
          setError(`录音过大。${SIZE_LIMIT_TEXT}，请录制一段较短的语音`);
          return;
        }
        session.chunks.push(data);
      };
      recorder.onerror = () => {
        if (sessionRef.current === session) {
          cancelRecording();
          setError("录音中断，请检查麦克风后重试");
        }
      };
      recorder.onstop = () => {
        if (sessionRef.current !== session) {
          return;
        }
        cancelRecording();
        const recordedType = recorder.mimeType || session.chunks[0]?.type || "";
        const mimeType = normalizeMimeType(recordedType);
        if (session.byteLength === 0 || mimeType === undefined || !mimeType.startsWith("audio/")) {
          setError("未生成可发送的录音，可以重试或上传音频文件");
          return;
        }
        setAttachment({
          blob: new Blob(session.chunks, { type: mimeType }),
          mimeType,
          name: "录音",
        });
      };
      // 分段收集后可在采集期间检查大小，各浏览器仍使用同一个连续录音容器。
      recorder.start(500);
      setPhase("recording");
    } catch (cause) {
      if (sessionRef.current === session) {
        cancelRecording();
        setError(
          cause instanceof DOMException && cause.name === "NotAllowedError"
            ? "麦克风权限未开启，可以在浏览器中允许访问或上传音频文件"
            : "无法开启麦克风，请检查设备或上传音频文件",
        );
      }
    }
  };

  const finishRecording = (): void => {
    const recorder = sessionRef.current?.recorder;
    if (recorder !== undefined && recorder.state !== "inactive") {
      setPhase("finishing");
      recorder.stop();
    }
  };

  return {
    attachment,
    error,
    phase,
    isPreparingImage,
    canRecord,
    chooseFiles,
    chooseSticker,
    clearAttachment,
    restoreAttachment,
    startRecording,
    finishRecording,
    cancelRecording,
  };
}
