/**
 * @module web/components/primitives/toaster
 * @description 基于 `sonner` 的全局 Atelier Daylight & Obsidian Studio 轻提示宿主（`AppToaster`）及 `toast` 触发函数重导出。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 自动追踪 `.dark` 主题类：通过 `useSyncExternalStore` + `MutationObserver` 实时监听 `<html>` 的 `.dark` 类切换，轻提示胶囊在暖瓷白与黑曜石表面之间零延迟同步换肤。
 * 2. 不遮挡底部聊天输入舱：默认定位在 `"top-center"`，确保桌面与移动端的底部输入区始终畅通。
 */
import { useSyncExternalStore } from "react";
import { type ExternalToast, Toaster, toast } from "sonner";

export { toast };
export type { ExternalToast };

function subscribeHtmlDarkClass(listener: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(() => {
    listener();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => {
    observer.disconnect();
  };
}

function getHtmlThemeSnapshot(): "light" | "dark" {
  if (typeof document !== "undefined") {
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  }
  return "light";
}

/** `AppToaster` 入参属性 */
export interface AppToasterProps {
  /** 可选强制指定主题；省略时自动跟随 `document.documentElement` 的 `.dark` 类 */
  readonly theme?: "light" | "dark" | "system" | undefined;
  /** 屏幕停靠方位（默认 `"top-center"`，避免遮挡 IM 底部输入区） */
  readonly position?:
    | "top-left"
    | "top-center"
    | "top-right"
    | "bottom-left"
    | "bottom-center"
    | "bottom-right"
    | undefined;
}

/**
 * 渲染全局纯净圆角轻提示容器（在 `main.tsx` 挂载一次）。
 *
 * @param props - 可选主题覆盖与停靠位置
 * @returns 配置好 Pachat 双主题样式的 Sonner `<Toaster />`
 */
export function AppToaster(props: AppToasterProps) {
  const { theme, position = "top-center" } = props;
  const observedTheme = useSyncExternalStore<"light" | "dark">(
    subscribeHtmlDarkClass,
    getHtmlThemeSnapshot,
    () => "light",
  );

  return (
    <Toaster
      theme={theme ?? observedTheme}
      position={position}
      richColors={false}
      offset={14}
      duration={2600}
      toastOptions={{
        classNames: {
          toast:
            "app-no-drag !rounded-2xl !px-4 !py-3 !text-[13px] !font-medium !backdrop-blur-2xl !backdrop-saturate-180 !shadow-[0_16px_42px_-10px_rgba(15,23,42,0.18)] !border !border-white/50 !bg-white/82 !text-[#111318] dark:!bg-[#1E1E22]/88 dark:!text-[#F2F2F4] dark:!border-white/[0.12] dark:!shadow-[0_22px_54px_-12px_rgba(0,0,0,0.78)]",
          description: "!text-xs !text-[#687082] dark:!text-[#7D869C]",
          actionButton:
            "!rounded-full !bg-[#181B22] !text-white dark:!bg-[#EAEEF6] dark:!text-[#111318] !text-xs !font-medium !px-3",
          cancelButton:
            "!rounded-full !bg-black/[0.05] !text-[#111318] dark:!bg-white/[0.09] dark:!text-[#ECEFF6] !text-xs !px-3",
        },
      }}
    />
  );
}
