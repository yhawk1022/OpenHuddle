/**
 * @module web/components/primitives/toaster
 * @description 基于 `sonner` 的全局 Pachat 极简轻提示宿主（`AppToaster`）及 `toast` 触发函数重导出。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 自动追踪 `.dark` 主题类：通过 `useSyncExternalStore` + `MutationObserver` 实时监听 `<html>` 的 `.dark` 类切换，轻提示胶囊在 `#FFFFFF` 与 `#18181B` 之间零延迟同步换肤。
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
            "app-no-drag !rounded-2xl !px-4 !py-3 !text-[13px] !font-medium !backdrop-blur-xl !shadow-[0_14px_38px_-10px_rgba(0,0,0,0.16)] !border !border-black/[0.08] !bg-white/98 !text-[#141414] dark:!bg-[#18181B]/98 dark:!text-zinc-100 dark:!border-white/[0.12] dark:!shadow-[0_18px_46px_-10px_rgba(0,0,0,0.75)]",
          description: "!text-xs !text-[#6E6E73] dark:!text-zinc-400",
          actionButton:
            "!rounded-full !bg-[#141414] !text-white dark:!bg-[#F5F5F7] dark:!text-[#141414] !text-xs !font-medium !px-3",
          cancelButton:
            "!rounded-full !bg-[#F5F5F7] !text-[#141414] dark:!bg-white/10 dark:!text-zinc-200 !text-xs !px-3",
        },
      }}
    />
  );
}
