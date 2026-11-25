/**
 * @module web/components/primitives/toaster
 * @description 基于 `sonner` 的全局轻提示宿主（`AppToaster`）及 `toast` 触发函数重导出。
 *
 * 关键不变量：
 * 1. 统一消费 `theme-store` 的 `useThemeMode()`，与根节点明暗主题切换同步。
 * 2. 默认停靠在 `"top-center"`，避免遮挡桌面与移动端底部聊天输入区。
 */
import { type ExternalToast, Toaster, toast } from "sonner";
import { useThemeMode } from "../../lib/theme-store.js";

export { toast };
export type { ExternalToast };

/** `AppToaster` 入参属性 */
export interface AppToasterProps {
  /** 可选强制指定主题；省略时跟随全局 `useThemeMode()` */
  readonly theme?: "light" | "dark" | "system" | undefined;
  /** 屏幕停靠方位（默认 `"top-center"`） */
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
 * 渲染全局圆角轻提示容器（在 `main.tsx` 挂载一次）。
 *
 * @param props - 可选主题覆盖与停靠位置
 * @returns 配置好明暗双主题样式的 Sonner `<Toaster />`
 */
export function AppToaster(props: AppToasterProps) {
  const { theme, position = "top-center" } = props;
  const observedTheme = useThemeMode();

  return (
    <Toaster
      theme={theme ?? observedTheme}
      position={position}
      richColors={false}
      offset={14}
      mobileOffset={{
        top: "max(16px, calc(env(safe-area-inset-top, 0px) + 8px))",
        left: "16px",
        right: "16px",
      }}
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
