/**
 * @module web/components/ui/modal-dialog
 * @description 通用无障碍 Pachat 极简模态弹窗门面：100% 保持 `ModalDialogProps` 向后兼容，内部委托给 `AppModal`（移动端 `< 640px` 自动切换为 `Vaul` iOS 物理阻尼底部抽屉，桌面端渲染为 Radix `Dialog` + `motion` 弹簧纯净 `#FFFFFF` / `#18181B` 居中窗口）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 契约零破坏兼容：完整保留既有 `ModalDialogProps`（`open` / `onClose` / `title` / `subtitle` / `maxWidthClass` / `icon` / `children`），并透传可选 `footer` / `hideHeader` / `bodyClassName` 扩展槽位。
 * 2. 多端物理自适应：桌面端由 Radix `Dialog.Portal` + `motion` 弹簧物理承载焦点锁定与 `Escape` 关闭；移动端由 `Vaul` `Drawer`（`noBodyStyles={true}`）提供原生跟手拖拽关闭且不破坏 `100dvh` 视口锁定。
 * 3. 桌面壳拖拽免疫：弹窗遮罩与面板统一附带 `.app-no-drag`，确保在 Tauri v2 / Electron 无边框窗口内点击不被顶栏拖拽区吞没。
 */
import type { ReactNode } from "react";
import { AppModal } from "../primitives/index.js";

/** `ModalDialog` 入参属性 */
export interface ModalDialogProps {
  /** 是否打开弹窗 */
  readonly open: boolean;
  /** 遮罩点击、关闭按钮、下拉手势或 `Escape` 触发的关闭回调 */
  readonly onClose: () => void;
  /** 弹窗主标题（同时绑定无障碍 `Dialog.Title` / `Drawer.Title`） */
  readonly title: string;
  /** 标题下方的一行辅助说明（同时绑定无障碍 `Description`） */
  readonly subtitle?: string | undefined;
  /** 桌面端卡片最大宽度 Tailwind 类（默认 `max-w-xl`） */
  readonly maxWidthClass?: string | undefined;
  /** 标题左侧可选的圆形极简图标槽位 */
  readonly icon?: ReactNode | undefined;
  /** 可选底部固定操作栏 */
  readonly footer?: ReactNode | undefined;
  /** 是否隐藏默认头部栏（仍保留屏幕阅读器标题） */
  readonly hideHeader?: boolean | undefined;
  /** 内容滚动区附加类名 */
  readonly bodyClassName?: string | undefined;
  /** 弹窗主体内容 */
  readonly children: ReactNode;
}

/**
 * 渲染桌面端纯净弹簧模态窗 + 移动端 `Vaul` 物理抽屉。
 *
 * @remarks
 * 作为业务层到 `AppModal` 原语的语义适配门面，确保全站弹窗具备一致的焦点环、无障碍标题描述与 Pachat 双主题极简对比度。
 *
 * @param props - 弹窗开关状态、标题说明、可选图标、底部栏与子内容
 * @returns 响应式原生级模态层
 */
export function ModalDialog(props: ModalDialogProps) {
  return (
    <AppModal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      subtitle={props.subtitle}
      maxWidthClass={props.maxWidthClass}
      icon={props.icon}
      footer={props.footer}
      hideHeader={props.hideHeader}
      bodyClassName={props.bodyClassName}
    >
      {props.children}
    </AppModal>
  );
}
