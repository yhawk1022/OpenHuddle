/**
 * @module web/components/ui/modal-dialog
 * @description 通用无障碍模态弹窗容器组件（支持键盘 `Escape` 关闭、遮罩点击关闭与响应式自适应宽度）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 严格使用语义化 `role="dialog"` 与显式 `type="button"` 关闭控件，确保键盘可访问性与 Biome a11y 零告警。
 */
import { X } from "lucide-react";
import { type ReactNode, useEffect } from "react";

/** `ModalDialog` 入参属性 */
export interface ModalDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly maxWidthClass?: string | undefined;
  readonly children: ReactNode;
}

/**
 * 渲染带毛玻璃遮罩与高质感边框的居中模态框。
 *
 * @param props - 弹窗开关状态、标题说明与子内容
 * @returns 打开时渲染模态层，关闭时返回 `null`
 */
export function ModalDialog(props: ModalDialogProps) {
  const { open, onClose } = props;

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const widthClass = props.maxWidthClass ?? "max-w-xl";

  return (
    <dialog
      open={true}
      aria-modal="true"
      aria-label={props.title}
      className="fixed inset-0 z-50 m-0 flex h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-transparent p-4"
    >
      <button
        type="button"
        aria-label="关闭弹窗遮罩"
        onClick={onClose}
        className="fixed inset-0 bg-slate-950/55 backdrop-blur-xs transition-opacity dark:bg-black/70"
      />
      <div
        className={`relative z-10 flex max-h-[90vh] w-full ${widthClass} flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white text-slate-900 shadow-2xl dark:border-white/12 dark:bg-[#10141d] dark:text-slate-100`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200/80 px-6 py-4 dark:border-white/[0.08]">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-slate-900 dark:text-white">
              {props.title}
            </h2>
            {props.subtitle ? (
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{props.subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭窗口"
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="overflow-y-auto px-6 py-5">{props.children}</div>
      </div>
    </dialog>
  );
}
