/**
 * @module web/features/pwa-install/pwa-install-guide
 * @description 跨平台差异化「添加到手机主屏幕」轻量引导横幅（`PwaInstallBanner`）与分步图文抽屉（`PwaInstallGuideModal`）。
 *
 * 设计守则：
 * 1. 严守 Liquid Glass 光学铁律：横幅嵌入已带毛玻璃的侧栏时不叠加二次 `backdrop-blur`。
 * 2. 原生几何图标：精准绘制 iOS/iPadOS 系统导出分享图标（方框+上箭头）、三点菜单与加号方框，无任何 Emoji 标题或 AI 装饰符。
 * 3. 全平台自适应：Android 支持 `beforeinstallprompt` 时提供一键原生安装主按钮；内置 WebView 提供一键复制网址与右上角菜单指引；国产 ROM 提供桌面快捷方式权限说明。
 */
import { Check, Compass, Copy, Smartphone, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { BrandMark } from "../../components/brand-mark.js";
import { AppButton } from "../../components/primitives/index.js";
import { ModalDialog } from "../../components/ui/modal-dialog.js";
import {
  markPwaInstalled,
  snoozePwaSmartBanner,
  triggerNativePwaInstall,
  usePwaInstallState,
} from "./pwa-install-store.js";
import type { StepGlyphKind } from "./pwa-platform-detect.js";

function StepGlyphIcon(props: { readonly kind: StepGlyphKind }) {
  switch (props.kind) {
    case "ios-share":
      // 精准绘制 Apple 系统原生 Share 图标（上开口圆角矩形 + 居中向上箭头）
      return (
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.65"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4 shrink-0"
          aria-hidden="true"
        >
          <path d="M10 12.5V3.2" />
          <path d="M6.8 6.2L10 3l3.2 3.2" />
          <path d="M6 9.5H5.2A1.7 1.7 0 0 0 3.5 11.2v4.6a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7v-4.6A1.7 1.7 0 0 0 14.8 9.5H14" />
        </svg>
      );
    case "more-horizontal":
      return (
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4 shrink-0"
          aria-hidden="true"
        >
          <circle cx="4.5" cy="10" r="1.45" />
          <circle cx="10" cy="10" r="1.45" />
          <circle cx="15.5" cy="10" r="1.45" />
        </svg>
      );
    case "more-vertical":
      return (
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4 shrink-0"
          aria-hidden="true"
        >
          <circle cx="10" cy="4.5" r="1.45" />
          <circle cx="10" cy="10" r="1.45" />
          <circle cx="10" cy="15.5" r="1.45" />
        </svg>
      );
    case "hamburger-menu":
      return (
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          className="h-4 w-4 shrink-0"
          aria-hidden="true"
        >
          <path d="M3.8 5.8h12.4M3.8 10h12.4M3.8 14.2h12.4" />
        </svg>
      );
    case "plus-square":
      return (
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.65"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4 shrink-0"
          aria-hidden="true"
        >
          <rect x="3.2" y="3.2" width="13.6" height="13.6" rx="3.2" />
          <path d="M10 6.8v6.4M6.8 10h6.4" />
        </svg>
      );
    case "browser-compass":
      return <Compass className="h-4 w-4 shrink-0" aria-hidden="true" />;
    case "check-confirm":
      return <Check className="h-4 w-4 shrink-0" aria-hidden="true" />;
  }
}

export interface PwaInstallBannerProps {
  /** 点击查看详细步骤时的回调（唤起 `PwaInstallGuideModal`） */
  readonly onOpenGuide: () => void;
  readonly className?: string | undefined;
}

/**
 * 移动端会话列表顶部的克制型「添加到手机主屏幕」提示条。
 * 已处于 Standalone 独立应用模式或用户已关闭时自动静默不渲染。
 */
export function PwaInstallBanner(props: PwaInstallBannerProps) {
  const { profile, shouldShowSmartBanner } = usePwaInstallState();
  const [installing, setInstalling] = useState(false);

  if (!shouldShowSmartBanner) {
    return null;
  }

  const handlePrimaryAction = async (): Promise<void> => {
    if (profile.canTriggerNativePrompt) {
      setInstalling(true);
      try {
        const outcome = await triggerNativePwaInstall();
        if (outcome === "accepted") {
          toast.success("已添加到手机主屏幕");
          return;
        }
        if (outcome === "unavailable") {
          props.onOpenGuide();
        }
      } finally {
        setInstalling(false);
      }
      return;
    }
    props.onOpenGuide();
  };

  return (
    <section className={`md:hidden ${props.className ?? ""}`} aria-label="添加到手机主屏幕提示">
      <div className="flex items-center gap-2.5 rounded-xl border border-im-border bg-im-surface/90 px-3 py-2">
        <BrandMark size={30} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold leading-tight text-im-fg">
            添加到手机主屏幕
          </div>
          <div className="mt-0.5 truncate text-[11px] leading-tight text-im-muted">
            {profile.inAppHostLabel
              ? `从${profile.inAppHostLabel}用浏览器打开并固定桌面`
              : "像原生 App 一样全屏秒开"}
          </div>
        </div>
        <AppButton
          type="button"
          variant="primary"
          size="xs"
          isLoading={installing}
          onClick={() => {
            void handlePrimaryAction();
          }}
          className="h-7 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-[11.5px]"
        >
          {profile.canTriggerNativePrompt ? "立即添加" : "添加"}
        </AppButton>
        <button
          type="button"
          onClick={snoozePwaSmartBanner}
          aria-label="暂时关闭主屏幕提示"
          className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-im-subtle transition-colors hover:bg-im-hover hover:text-im-fg after:absolute after:-inset-1.5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </section>
  );
}

export interface PwaInstallGuideModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * 全平台差异化「添加到手机主屏幕」分步操作抽屉/弹窗。
 */
export function PwaInstallGuideModal(props: PwaInstallGuideModalProps) {
  const { profile } = usePwaInstallState();
  const [installing, setInstalling] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const handleNativeInstall = async (): Promise<void> => {
    setInstalling(true);
    try {
      const outcome = await triggerNativePwaInstall();
      if (outcome === "accepted") {
        toast.success("已添加到手机主屏幕");
        props.onClose();
      }
    } finally {
      setInstalling(false);
    }
  };

  const handleCopyCurrentUrl = async (): Promise<void> => {
    if (typeof window === "undefined") {
      return;
    }
    const targetUrl = window.location.origin;
    try {
      await navigator.clipboard.writeText(targetUrl);
      setCopiedUrl(true);
      toast.success("已复制网址，请粘贴到系统浏览器打开");
      window.setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      toast.error("复制失败，请点击右上角菜单在浏览器打开");
    }
  };

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title="添加到手机主屏幕"
      subtitle={`已识别当前环境：${profile.browserLabel}`}
      maxWidthClass="max-w-md"
      icon={<Smartphone className="h-4 w-4" />}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              markPwaInstalled();
              toast.success("已记录，后续不再提示添加");
              props.onClose();
            }}
            className="cursor-pointer text-xs font-medium text-im-muted transition-colors hover:text-im-fg"
          >
            我已添加，不再提示
          </button>
          <AppButton type="button" variant="secondary" size="md" onClick={props.onClose}>
            知道了
          </AppButton>
        </div>
      }
    >
      <div className="space-y-4">
        {/* 品牌与应用图标预览卡 */}
        <div className="flex items-center gap-3 rounded-xl border border-im-border bg-im-surface/70 p-3">
          <BrandMark size={42} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-im-fg">OpenHuddle</div>
            <div className="mt-0.5 text-xs leading-relaxed text-im-muted">
              独立全屏窗口运行，隐藏浏览器地址栏，从桌面一键直达群聊与工作台。
            </div>
          </div>
        </div>

        {/* Android 原生一键安装主入口 */}
        {profile.canTriggerNativePrompt ? (
          <AppButton
            type="button"
            variant="primary"
            size="lg"
            isLoading={installing}
            onClick={() => {
              void handleNativeInstall();
            }}
            className="w-full justify-center"
          >
            立即添加到主屏幕
          </AppButton>
        ) : null}

        {/* App 内置 WebView 辅助复制网址按钮 */}
        {profile.inAppHost !== null ? (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-im-border bg-im-surface/60 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-im-fg">备选方式：复制网址到浏览器</div>
              <div className="truncate font-mono text-[11px] text-im-muted">
                {typeof window !== "undefined" ? window.location.origin : "https://openhuddle.app"}
              </div>
            </div>
            <AppButton
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void handleCopyCurrentUrl();
              }}
              className="shrink-0 whitespace-nowrap"
            >
              {copiedUrl ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedUrl ? "已复制" : "复制网址"}
            </AppButton>
          </div>
        ) : null}

        {/* 定制分步操作列表 */}
        {profile.steps.length > 0 ? (
          <ol className="divide-y divide-im-border rounded-xl border border-im-border bg-im-surface/50">
            {profile.steps.map((step, index) => (
              <li key={step.title} className="flex items-start gap-3 px-3.5 py-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-im-border bg-im-canvas font-mono text-[11.5px] font-semibold text-im-fg">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium leading-snug text-im-fg">
                    {step.title}
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-im-muted">{step.detail}</div>
                </div>
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-im-border bg-im-canvas text-im-fg">
                  <StepGlyphIcon kind={step.glyph} />
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        {/* 国产 Android ROM 桌面快捷方式权限说明 / iOS 第三方浏览器备选提示 */}
        {profile.secondaryNote ? (
          <div className="rounded-xl border border-im-border bg-im-surface/40 px-3.5 py-2.5 text-xs leading-relaxed text-im-muted">
            <span className="font-medium text-im-fg">
              {profile.needsAndroidRomShortcutTip ? "权限提示：" : "提示："}
            </span>
            {profile.secondaryNote}
          </div>
        ) : null}
      </div>
    </ModalDialog>
  );
}
