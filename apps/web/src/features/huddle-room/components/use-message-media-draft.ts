/**
 * @module web/features/huddle-room/use-message-media-draft
 * @description 消息附件选择与麦克风采集。房间切换或取消录音时释放设备，迟到的授权结果不能写入新草稿。
 */
import {
  MAX_MESSAGE_ATTACHMENT_BYTES,
  type MessageAttachmentMimeType,
  MessageAttachmentMimeTypeSchema,
} from "@openhuddle/protocol";
import { useEffect, useRef, useState } from "react";
import type { DraftMessageAttachment } from "../../../lib/message-media.js";

/** 文件选择器只显示房间消息支持的媒体格式。 */
export const MESSAGE_MEDIA_ACCEPT = [
  ...MessageAttachmentMimeTypeSchema.options,
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".webm",
  ".ogg",
  ".m4a",
  ".mp3",
  ".wav",
].join(",");

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

function readFileMimeType(file: File): MessageAttachmentMimeType | undefined {
  const mimeType = normalizeMimeType(file.type);
  if (mimeType !== undefined) {
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
    return MIME_BY_EXTENSION[extension];
  }
  return undefined;
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
  const sessionRef = useRef<RecordingSession | null>(null);
  const canRecord =
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";

  useEffect(
    () => () => {
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

  const chooseFile = (file: File): void => {
    const mimeType = readFileMimeType(file);
    if (mimeType === undefined) {
      setError("请选择 JPG、PNG、GIF、WebP 图片，或 WebM、OGG、M4A、MP3、WAV 音频");
      return;
    }
    if (file.size === 0 || file.size > MAX_MESSAGE_ATTACHMENT_BYTES) {
      setError(file.size === 0 ? "无法发送空文件" : SIZE_LIMIT_TEXT);
      return;
    }
    setAttachment({ blob: file, mimeType, name: file.name });
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
    canRecord,
    chooseFile,
    clearAttachment,
    startRecording,
    finishRecording,
    cancelRecording,
  };
}
