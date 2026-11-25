/**
 * @module web/features/huddle-room/sticker-picker
 * @description 输入栏的表情入口。选中后只更新草稿，关闭面板会取消未完成的内置图片读取。
 */
import type { UserId } from "@openhuddle/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Sticker, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AppPopover, cn } from "../../../components/primitives/index.js";
import {
  STICKER_FILE_ACCEPT,
  type SavedSticker,
  type StickerImage,
  importSticker,
  listSavedStickers,
  removeSavedSticker,
} from "../stickers/sticker-library.js";

const BUILT_IN_STICKERS = [
  { id: "thumbs-up", name: "收到" },
  { id: "laugh", name: "笑出眼泪" },
  { id: "wave", name: "打招呼" },
  { id: "thinking", name: "我想想" },
  { id: "heart", name: "比心" },
  { id: "celebrate", name: "庆祝" },
] as const;

const STICKER_BUTTON_CLASS =
  "flex w-full min-w-0 cursor-pointer flex-col items-center gap-1 rounded-xl p-1.5 text-[11px] text-[#5C6575] transition-colors hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-black/25 focus-visible:outline-none disabled:cursor-wait dark:text-[#BFC2CC] dark:hover:bg-white/[0.09] dark:focus-visible:ring-white/35";

function builtInStickerPath(id: string): string {
  return `/stickers/huddle-bot-${id}.webp`;
}

/** 个人表情缓存与账号绑定，收藏和移除共用同一个失效键。 */
export function savedStickerQueryKey(userId: UserId) {
  return ["saved-stickers", userId] as const;
}

function SavedStickerTile(props: {
  readonly sticker: SavedSticker;
  readonly disabled: boolean;
  readonly onSelect: (sticker: StickerImage) => void;
  readonly onRemove: (id: string) => void;
}) {
  const { sticker } = props;
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const objectUrl = URL.createObjectURL(sticker.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [sticker.blob]);

  return (
    <li className="relative">
      <button
        type="button"
        className={STICKER_BUTTON_CLASS}
        disabled={props.disabled}
        aria-label={`选择表情 ${sticker.name}`}
        title={sticker.name}
        onClick={() => props.onSelect(sticker)}
      >
        <span className="grid h-12 w-full place-items-center">
          {url !== undefined ? <img src={url} alt="" className="h-12 w-12 object-contain" /> : null}
        </span>
        <span className="w-full truncate text-center">{sticker.name}</span>
      </button>
      <button
        type="button"
        aria-label={`移除表情 ${sticker.name}`}
        title="移除表情"
        disabled={props.disabled}
        className="absolute right-0.5 top-0.5 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-white/90 text-[#687082] shadow-xs hover:text-red-600 focus-visible:ring-2 focus-visible:outline-none dark:bg-[#282B31] dark:text-[#C4C4CA] dark:hover:text-red-300"
        onClick={() => props.onRemove(sticker.id)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

/** 将内置和个人表情加入当前消息草稿，收藏状态由浏览器持久化。 */
export function StickerPicker(props: {
  readonly userId: UserId;
  readonly disabled: boolean;
  readonly triggerClassName: string;
  readonly onSelect: (sticker: StickerImage) => void;
}) {
  const { userId, disabled, onSelect } = props;
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<"built-in" | "saved">("built-in");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const selection = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();
  const queryKey = savedStickerQueryKey(userId);
  const saved = useQuery({
    queryKey,
    queryFn: () => listSavedStickers(userId),
    enabled: open && category === "saved" && !disabled,
    networkMode: "always",
    retry: false,
  });

  useEffect(() => () => selection.current?.abort(), []);
  useEffect(() => {
    if (disabled) {
      selection.current?.abort();
      setOpen(false);
    }
  }, [disabled]);

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      selection.current?.abort();
    }
    setError(undefined);
    setOpen(nextOpen);
  };

  const chooseBuiltIn = async (sticker: (typeof BUILT_IN_STICKERS)[number]): Promise<void> => {
    if (selection.current !== null) {
      return;
    }
    const controller = new AbortController();
    selection.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(builtInStickerPath(sticker.id), { signal: controller.signal });
      if (!response.ok) {
        throw new Error("无法读取这张表情");
      }
      const blob = await response.blob();
      if (blob.type !== "image/webp" || blob.size === 0) {
        throw new Error("表情文件不可用");
      }
      if (!controller.signal.aborted) {
        onSelect({ blob, mimeType: "image/webp", name: sticker.name });
        setOpen(false);
      }
    } catch {
      if (!controller.signal.aborted) {
        setError("表情加载失败，请重新选择");
      }
    } finally {
      selection.current = null;
      setBusy(false);
    }
  };

  const updateLibrary = async (operation: () => Promise<void>, success: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      await queryClient.invalidateQueries({ queryKey });
      toast.success(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存表情，请检查浏览器存储权限");
    } finally {
      setBusy(false);
    }
  };

  const isBusy = disabled || busy;

  return (
    <AppPopover
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      side="top"
      align="start"
      sideOffset={14}
      className="w-[min(19rem,calc(100vw-24px))] p-3"
      trigger={
        <button
          type="button"
          aria-label="表情包"
          title="表情包"
          disabled={disabled}
          className={cn(
            props.triggerClassName,
            "data-[state=open]:bg-black/[0.08] dark:data-[state=open]:bg-white/[0.12]",
          )}
        >
          <Sticker className="h-[17px] w-[17px]" />
        </button>
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div
          aria-label="表情分类"
          className="inline-flex gap-0.5 rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.08]"
        >
          {(
            [
              ["built-in", "内置表情"],
              ["saved", "我的表情"],
            ] as const
          ).map(([value, name]) => (
            <button
              key={value}
              type="button"
              aria-pressed={category === value}
              disabled={isBusy}
              onClick={() => {
                setCategory(value);
                setError(undefined);
              }}
              className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-medium text-[#5C6575] transition-colors hover:text-[#111318] aria-pressed:bg-white aria-pressed:text-[#111318] aria-pressed:shadow-xs dark:text-[#BFC2CC] dark:hover:text-white dark:aria-pressed:bg-[#383B45] dark:aria-pressed:text-white"
            >
              {name}
            </button>
          ))}
        </div>
        {category === "saved" ? (
          <>
            <input
              ref={fileInput}
              aria-label="选择自定义表情图片"
              hidden
              type="file"
              accept={STICKER_FILE_ACCEPT}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file !== undefined) {
                  void updateLibrary(() => importSticker(userId, file), "已添加表情");
                }
              }}
            />
            <button
              type="button"
              disabled={isBusy}
              onClick={() => fileInput.current?.click()}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium hover:bg-black/[0.05] disabled:opacity-50 dark:hover:bg-white/[0.08]"
            >
              <Plus className="h-3.5 w-3.5" /> 添加图片
            </button>
          </>
        ) : null}
      </div>

      {category === "built-in" ? (
        <ul className="mt-2 grid grid-cols-3 gap-1">
          {BUILT_IN_STICKERS.map((sticker) => (
            <li key={sticker.id}>
              <button
                type="button"
                aria-label={`选择表情 ${sticker.name}`}
                className={STICKER_BUTTON_CLASS}
                disabled={isBusy}
                onClick={() => void chooseBuiltIn(sticker)}
              >
                <img
                  src={builtInStickerPath(sticker.id)}
                  alt=""
                  className="h-12 w-12 object-contain"
                />
                {sticker.name}
              </button>
            </li>
          ))}
        </ul>
      ) : saved.isPending ? (
        <output className="block px-2 py-6 text-center text-xs">正在读取收藏…</output>
      ) : saved.isError ? (
        <button
          type="button"
          onClick={() => void saved.refetch()}
          className="w-full px-2 py-6 text-center text-xs underline"
        >
          收藏加载失败，点击重试
        </button>
      ) : saved.data.length === 0 ? (
        <div className="px-2 py-6 text-center text-xs leading-relaxed text-[#687082] dark:text-[#ADADB6]">
          <p className="font-medium text-[#181B22] dark:text-[#ECECEF]">还没有收藏</p>
          <p className="mt-1">添加本地图片，或在聊天中收藏表情。</p>
        </div>
      ) : (
        <ul className="mt-2 grid max-h-[min(17rem,calc(var(--oh-vvh,100dvh)-9rem))] grid-cols-3 gap-1 overflow-y-auto overscroll-contain">
          {saved.data.map((sticker) => (
            <SavedStickerTile
              key={sticker.id}
              sticker={sticker}
              disabled={isBusy}
              onSelect={(image) => {
                onSelect(image);
                setOpen(false);
              }}
              onRemove={(id) =>
                void updateLibrary(() => removeSavedSticker(userId, id), "已移除表情")
              }
            />
          ))}
        </ul>
      )}

      {busy ? (
        <Loader2
          role="status"
          aria-label="正在处理表情"
          className="mx-auto mt-1 h-4 w-4 animate-spin"
        />
      ) : null}
      {error !== undefined ? (
        <p role="alert" className="mt-2 px-1 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </AppPopover>
  );
}
