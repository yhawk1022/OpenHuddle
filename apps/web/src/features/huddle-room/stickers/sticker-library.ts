/**
 * @module web/features/huddle-room/stickers/sticker-library
 * @description 存放当前浏览器的个人表情副本。写入在同一事务内检查账号配额，避免多个标签页同时超额。
 */
import {
  MAX_MESSAGE_ATTACHMENT_BYTES,
  type MessageAttachmentMimeType,
  type MessageDto,
  MessageStickerNameSchema,
  type SupportedLocale,
  type UserId,
} from "@openhuddle/protocol";
import { roomMessageAttachmentPath } from "../../../lib/api-client.js";
import { createClientOperationKey } from "../../../lib/format.js";
import { getStoredSessionToken } from "../../../lib/session-store.js";
import { getChatDetailTranslator } from "../i18n/chat-detail.js";

const STORE_NAME = "stickers";
const MAX_STICKERS = 48;
const MAX_LIBRARY_BYTES = 32 * 1024 * 1024;
const MAX_LIBRARY_MB = MAX_LIBRARY_BYTES / 1024 / 1024;
const MAX_STICKER_MB = MAX_MESSAGE_ATTACHMENT_BYTES / 1024 / 1024;

/** 内置表情定义（稳定内部 `id` 用于资源定位，展示名称随当前语种切换）。 */
export const BUILT_IN_STICKERS = [
  { id: "thumbs-up", labelKey: "sticker.builtin.thumbsUp" },
  { id: "laugh", labelKey: "sticker.builtin.laugh" },
  { id: "wave", labelKey: "sticker.builtin.wave" },
  { id: "thinking", labelKey: "sticker.builtin.thinking" },
  { id: "heart", labelKey: "sticker.builtin.heart" },
  { id: "celebrate", labelKey: "sticker.builtin.celebrate" },
] as const;

/** 单个内置表情条目类型。 */
export type BuiltInSticker = (typeof BUILT_IN_STICKERS)[number];

/** 内置表情稳定内部键联合类型。 */
export type BuiltInStickerId = BuiltInSticker["id"];

/** 表情面板分组定义（稳定内部 `id` + 词典标签键）。 */
export const STICKER_CATEGORIES = [
  { id: "built-in", labelKey: "sticker.tab.builtIn" },
  { id: "saved", labelKey: "sticker.tab.saved" },
] as const;

/** 表情面板分组标识类型。 */
export type StickerCategoryId = (typeof STICKER_CATEGORIES)[number]["id"];

/** 按当前或指定语种获取内置表情的展示标签。 */
export function getBuiltInStickerLabel(id: BuiltInStickerId, locale?: SupportedLocale): string {
  const { t } = getChatDetailTranslator(locale);
  const entry = BUILT_IN_STICKERS.find((item) => item.id === id);
  return entry !== undefined ? t(entry.labelKey) : id;
}

/** 按当前或指定语种获取表情分组的展示标签。 */
export function getStickerCategoryLabel(id: StickerCategoryId, locale?: SupportedLocale): string {
  const { t } = getChatDetailTranslator(locale);
  const entry = STICKER_CATEGORIES.find((item) => item.id === id);
  return entry !== undefined ? t(entry.labelKey) : id;
}

/** 发送表情需要的原始图片字节与描述。 */
export interface StickerImage {
  readonly blob: Blob;
  readonly mimeType: Extract<MessageAttachmentMimeType, `image/${string}`>;
  readonly name: string;
}

/** 个人收藏中可独立移除的一项表情。 */
export interface SavedSticker extends StickerImage {
  readonly id: string;
  readonly userId: UserId;
  readonly createdAt: number;
}

const MIME_BY_EXTENSION: Readonly<Record<string, StickerImage["mimeType"]>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/** 本地表情选择器支持的 MIME 类型与文件扩展名。 */
export const STICKER_FILE_ACCEPT = [
  ...new Set(Object.values(MIME_BY_EXTENSION)),
  ...Object.keys(MIME_BY_EXTENSION).map((extension) => `.${extension}`),
].join(",");

function isStickerMimeType(mimeType: string): mimeType is StickerImage["mimeType"] {
  return Object.values(MIME_BY_EXTENSION).some((supported) => supported === mimeType);
}

async function openStickerDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("openhuddle-stickers", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: ["userId", "id"] });
      store.createIndex("userId", "userId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function openStickerTransaction(mode: IDBTransactionMode): Promise<IDBTransaction> {
  const database = await openStickerDatabase();
  try {
    return database.transaction(STORE_NAME, mode);
  } finally {
    // close 会等已创建的事务结束，释放连接以允许其他标签页升级数据库。
    database.close();
  }
}

/** 按添加时间倒序读取当前账号的收藏。 */
export async function listSavedStickers(userId: UserId): Promise<readonly SavedSticker[]> {
  const transaction = await openStickerTransaction("readonly");
  return new Promise((resolve, reject) => {
    const request: IDBRequest<SavedSticker[]> = transaction
      .objectStore(STORE_NAME)
      .index("userId")
      .getAll(userId);
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function addSticker(sticker: SavedSticker): Promise<"added" | "exists"> {
  const transaction = await openStickerTransaction("readwrite");
  return new Promise((resolve, reject) => {
    const store = transaction.objectStore(STORE_NAME);
    const request: IDBRequest<SavedSticker[]> = store.index("userId").getAll(sticker.userId);
    let result: "added" | "exists" = "added";
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error);
    request.onsuccess = () => {
      const existing = request.result;
      if (existing.some((item) => item.id === sticker.id)) {
        result = "exists";
        return;
      }
      const totalBytes = existing.reduce((sum, item) => sum + item.blob.size, sticker.blob.size);
      if (existing.length >= MAX_STICKERS || totalBytes > MAX_LIBRARY_BYTES) {
        const { t } = getChatDetailTranslator();
        reject(
          new Error(
            t("sticker.err.libraryLimit", { maxCount: MAX_STICKERS, maxMb: MAX_LIBRARY_MB }),
          ),
        );
        transaction.abort();
        return;
      }
      store.add(sticker);
    };
  });
}

/** 验证并导入本地图片，保留 GIF 和 WebP 的原始动画帧。 */
export async function importSticker(userId: UserId, file: File): Promise<void> {
  const { t } = getChatDetailTranslator();
  const extension = /\.([a-z0-9]+)$/iu.exec(file.name)?.[1]?.toLowerCase() ?? "";
  const mimeType =
    file.type === "" || file.type === "application/octet-stream"
      ? MIME_BY_EXTENSION[extension]
      : file.type;
  if (mimeType === undefined || !isStickerMimeType(mimeType)) {
    throw new Error(t("sticker.err.invalidFormat"));
  }
  if (file.size === 0 || file.size > MAX_MESSAGE_ATTACHMENT_BYTES) {
    throw new Error(t("sticker.err.invalidSize", { maxMb: MAX_STICKER_MB }));
  }

  const blob = file.slice(0, file.size, mimeType);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
  } catch {
    throw new Error(t("sticker.err.unreadableImage"));
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const name = MessageStickerNameSchema.safeParse(file.name.replace(/\.[^.]+$/u, "").slice(0, 80));
  await addSticker({
    id: createClientOperationKey(),
    userId,
    blob,
    mimeType,
    name: name.success ? name.data : t("sticker.defaultCustomName"),
    createdAt: Date.now(),
  });
}

/** 复制已确认的房间表情。同一条消息重复收藏只保留一份。 */
export async function saveRoomSticker(
  userId: UserId,
  message: MessageDto,
): Promise<"added" | "exists"> {
  const { t } = getChatDetailTranslator();
  const attachment = message.attachment;
  if (attachment?.stickerName === undefined || !isStickerMimeType(attachment.mimeType)) {
    throw new Error(t("sticker.err.noStickerInMessage"));
  }

  const sessionToken = getStoredSessionToken();
  const response = await fetch(roomMessageAttachmentPath(message.roomId, message.seq), {
    credentials: "include",
    ...(sessionToken ? { headers: { Authorization: `Bearer ${sessionToken}` } } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(t("sticker.err.fetchMessageStickerFailed"));
  }
  const blob = await response.blob();
  const normalizedMime = blob.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (blob.size !== attachment.byteLength || normalizedMime !== attachment.mimeType.toLowerCase()) {
    throw new Error(t("sticker.err.fetchMessageStickerFailed"));
  }

  return addSticker({
    id: `message:${message.roomId}:${String(message.seq)}`,
    userId,
    blob,
    mimeType: attachment.mimeType,
    name: attachment.stickerName,
    createdAt: Date.now(),
  });
}

/** 移除当前账号收藏的本地副本。 */
export async function removeSavedSticker(userId: UserId, id: string): Promise<void> {
  const transaction = await openStickerTransaction("readwrite");
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.objectStore(STORE_NAME).delete([userId, id]);
  });
}
