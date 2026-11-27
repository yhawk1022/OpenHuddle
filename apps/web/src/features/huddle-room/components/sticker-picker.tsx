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
import { getChatDetailTranslator, useChatDetailI18n } from "../i18n/chat-detail.js";
import {
  BUILT_IN_STICKERS,
  type BuiltInSticker,
  STICKER_CATEGORIES,
  STICKER_FILE_ACCEPT,
  type SavedSticker,
  type StickerCategoryId,
  type StickerImage,
  importSticker,
  listSavedStickers,
  removeSavedSticker,
} from "../stickers/sticker-library.js";

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
  const { t } = useChatDetailI18n();
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
        aria-label={t("sticker.aria.select", { name: sticker.name })}
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
        aria-label={t("sticker.aria.remove", { name: sticker.name })}
        title={t("sticker.removeTooltip")}
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
  const { t } = useChatDetailI18n();
  const { userId, disabled, onSelect } = props;
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<StickerCategoryId>("built-in");
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

  const chooseBuiltIn = async (sticker: BuiltInSticker): Promise<void> => {
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
        throw new Error(getChatDetailTranslator().t("sticker.err.readBuiltInFailed"));
      }
      const blob = await response.blob();
      if (blob.type !== "image/webp" || blob.size === 0) {
        throw new Error(getChatDetailTranslator().t("sticker.err.fileUnavailable"));
      }
      if (!controller.signal.aborted) {
        const displayName = getChatDetailTranslator().t(sticker.labelKey);
        onSelect({ blob, mimeType: "image/webp", name: displayName });
        setOpen(false);
      }
    } catch {
      if (!controller.signal.aborted) {
        setError(getChatDetailTranslator().t("sticker.err.loadFailed"));
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
      setError(
        cause instanceof Error
          ? cause.message
          : getChatDetailTranslator().t("sticker.err.savePermission"),
      );
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
          aria-label={t("sticker.triggerLabel")}
          title={t("sticker.triggerLabel")}
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
          aria-label={t("sticker.categoryAriaLabel")}
          className="inline-flex gap-0.5 rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.08]"
        >
          {STICKER_CATEGORIES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={category === item.id}
              disabled={isBusy}
              onClick={() => {
                setCategory(item.id);
                setError(undefined);
              }}
              className="cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-[#5C6575] transition-colors hover:text-[#111318] aria-pressed:bg-white aria-pressed:text-[#111318] aria-pressed:shadow-xs dark:text-[#BFC2CC] dark:hover:text-white dark:aria-pressed:bg-[#383B45] dark:aria-pressed:text-white"
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
        {category === "saved" ? (
          <>
            <input
              ref={fileInput}
              aria-label={t("sticker.aria.chooseCustomFile")}
              hidden
              type="file"
              accept={STICKER_FILE_ACCEPT}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file !== undefined) {
                  void updateLibrary(() => importSticker(userId, file), t("sticker.toast.added"));
                }
              }}
            />
            <button
              type="button"
              disabled={isBusy}
              onClick={() => fileInput.current?.click()}
              className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1.5 text-xs font-medium hover:bg-black/[0.05] disabled:opacity-50 dark:hover:bg-white/[0.08]"
            >
              <Plus className="h-3.5 w-3.5" /> {t("sticker.addImageButton")}
            </button>
          </>
        ) : null}
      </div>

      {category === "built-in" ? (
        <ul className="mt-2 grid grid-cols-3 gap-1">
          {BUILT_IN_STICKERS.map((sticker) => {
            const label = t(sticker.labelKey);
            return (
              <li key={sticker.id}>
                <button
                  type="button"
                  aria-label={t("sticker.aria.select", { name: label })}
                  className={STICKER_BUTTON_CLASS}
                  disabled={isBusy}
                  onClick={() => void chooseBuiltIn(sticker)}
                >
                  <img
                    src={builtInStickerPath(sticker.id)}
                    alt=""
                    className="h-12 w-12 object-contain"
                  />
                  <span className="w-full truncate text-center">{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : saved.isPending ? (
        <output className="block px-2 py-6 text-center text-xs">{t("sticker.loadingSaved")}</output>
      ) : saved.isError ? (
        <button
          type="button"
          onClick={() => void saved.refetch()}
          className="w-full px-2 py-6 text-center text-xs underline"
        >
          {t("sticker.savedLoadError")}
        </button>
      ) : saved.data.length === 0 ? (
        <div className="px-2 py-6 text-center text-xs leading-relaxed text-[#687082] dark:text-[#ADADB6]">
          <p className="font-medium text-[#181B22] dark:text-[#ECECEF]">
            {t("sticker.emptyTitle")}
          </p>
          <p className="mt-1">{t("sticker.emptyHint")}</p>
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
                void updateLibrary(() => removeSavedSticker(userId, id), t("sticker.toast.removed"))
              }
            />
          ))}
        </ul>
      )}

      {busy ? (
        <Loader2
          role="status"
          aria-label={t("sticker.aria.processing")}
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
