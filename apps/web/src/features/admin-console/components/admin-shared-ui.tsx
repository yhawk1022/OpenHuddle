/**
 * @module web/features/admin-console/shared-ui
 * @description 运营与治理管理后台通用高质感界面原语（统计卡、状态胶囊、分页器、危险操作二次确认弹窗与四态容器）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 对齐全站设计令牌：仅使用 Atelier Daylight / Obsidian Studio 中性与功能语义色彩，数字强制 `tabular-nums` 等宽对齐。
 * 2. 四态完备性：提供标准化的 `AdminTableSkeleton`、`AdminEmptyState` 与 `AdminErrorState`，确保每个管理子页不出现闪烁与白屏。
 */
import type { AdminPagination } from "@openhuddle/protocol";
import { AlertCircle, ChevronLeft, ChevronRight, Inbox, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { AppButton, AppModal, cn } from "../../../components/primitives/index.js";

/** 状态胶囊配色语义变体 */
export type AdminTone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

const TONE_CLASS_MAP: Readonly<Record<AdminTone, string>> = {
  neutral:
    "border-black/[0.06] bg-[#F3F4F7] text-[#4A5162] dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-[#B4BCD0]",
  success:
    "border-[#16A34A]/15 bg-[#E8F5EE] text-[#145335] dark:border-[#34D399]/20 dark:bg-[#162923] dark:text-[#6EE7B7]",
  warning:
    "border-[#D97706]/20 bg-[#FEF3C7] text-[#78350F] dark:border-[#FBBF24]/20 dark:bg-[#2E2516] dark:text-[#FCD34D]",
  danger:
    "border-[#E5484D]/20 bg-[#FEE2E2] text-[#991B1B] dark:border-[#F05252]/25 dark:bg-[#31171A] dark:text-[#FCA5A5]",
  info: "border-[#2563EB]/15 bg-[#E1ECFF] text-[#1E3A8A] dark:border-[#60A5FA]/20 dark:bg-[#1A273D] dark:text-[#93C5FD]",
  accent:
    "border-[#181B22]/15 bg-[#181B22] text-white dark:border-white/20 dark:bg-[#EAEEF6] dark:text-[#111318]",
};

/**
 * 格式化 ISO 时间为紧凑本地日期时间（`YYYY-MM-DD HH:mm`）。
 */
export function formatAdminDateTime(iso: string | undefined): string {
  if (!iso) {
    return "—";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

/**
 * 格式化运行时长秒数为人类可读中文字符串（如 `2天 4小时` / `18分 30秒`）。
 */
export function formatUptimeDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const days = Math.floor(safe / 86_400);
  const hours = Math.floor((safe % 86_400) / 3_600);
  const mins = Math.floor((safe % 3_600) / 60);
  const secs = safe % 60;
  if (days > 0) {
    return `${days}天 ${hours}小时`;
  }
  if (hours > 0) {
    return `${hours}小时 ${mins}分`;
  }
  if (mins > 0) {
    return `${mins}分 ${secs}秒`;
  }
  return `${secs}秒`;
}

/** `AdminStatCard` 入参属性 */
export interface AdminStatCardProps {
  readonly label: string;
  readonly value: string | number;
  readonly hint?: string | undefined;
  readonly badge?: ReactNode | undefined;
  readonly icon?: ReactNode | undefined;
  readonly onClick?: (() => void) | undefined;
}

/**
 * 渲染运营大盘核心 KPI 统计卡片（带 `tabular-nums` 等宽数字与可选交互跳转）。
 */
export function AdminStatCard(props: AdminStatCardProps) {
  const content = (
    <div className="flex h-full flex-col justify-between gap-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12px] font-medium text-[#687082] dark:text-[#8E96AB]">
          {props.label}
        </span>
        {props.icon !== undefined ? (
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-black/[0.04] text-[#3B414E] dark:bg-white/[0.06] dark:text-[#B4BCD0]">
            {props.icon}
          </span>
        ) : null}
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[26px] font-semibold tracking-[-0.03em] text-[#111318] tabular-nums dark:text-[#ECEFF6]">
            {typeof props.value === "number" ? props.value.toLocaleString() : props.value}
          </span>
          {props.badge}
        </div>
        {props.hint !== undefined ? (
          <p className="mt-1 truncate text-[11.5px] text-[#687082] dark:text-[#7D869C]">
            {props.hint}
          </p>
        ) : null}
      </div>
    </div>
  );

  const cardClass = "oh-elevated-card rounded-2xl p-4 text-left transition-all duration-150";

  if (props.onClick !== undefined) {
    return (
      <button
        type="button"
        onClick={props.onClick}
        className={cn(
          cardClass,
          "cursor-pointer hover:-translate-y-0.5 hover:border-black/[0.14] active:translate-y-0 dark:hover:border-white/[0.16]",
        )}
      >
        {content}
      </button>
    );
  }

  return <div className={cardClass}>{content}</div>;
}

/** `AdminStatusPill` 入参属性 */
export interface AdminStatusPillProps {
  readonly tone?: AdminTone | undefined;
  readonly dotClass?: string | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

/**
 * 渲染精细描边胶囊状态标签。
 */
export function AdminStatusPill(props: AdminStatusPillProps) {
  const tone = props.tone ?? "neutral";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
        TONE_CLASS_MAP[tone],
        props.className,
      )}
    >
      {props.dotClass !== undefined ? (
        <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", props.dotClass)} />
      ) : null}
      <span>{props.children}</span>
    </span>
  );
}

/** `AdminPaginationBar` 入参属性 */
export interface AdminPaginationBarProps {
  readonly pagination: AdminPagination;
  readonly onPageChange: (nextPage: number) => void;
}

/**
 * 渲染分页控制栏（总条数、当前页码与上/下一页切换）。
 */
export function AdminPaginationBar(props: AdminPaginationBarProps) {
  const { page, pageSize, total, totalPages } = props.pagination;
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-black/[0.06] px-4 py-3 text-xs text-[#687082] dark:border-white/[0.07] dark:text-[#8E96AB]">
      <span className="tabular-nums">
        显示第 <strong className="font-semibold text-[#111318] dark:text-[#ECEFF6]">{start}</strong>
        –<strong className="font-semibold text-[#111318] dark:text-[#ECEFF6]">{end}</strong> 条，共{" "}
        <strong className="font-semibold text-[#111318] dark:text-[#ECEFF6]">{total}</strong> 条
      </span>
      <div className="flex items-center gap-1.5">
        <AppButton
          variant="secondary"
          size="xs"
          disabled={page <= 1}
          onClick={() => props.onPageChange(page - 1)}
          leadingIcon={<ChevronLeft className="h-3.5 w-3.5" />}
        >
          上一页
        </AppButton>
        <span className="px-2 font-medium tabular-nums text-[#111318] dark:text-[#ECEFF6]">
          {page} / {totalPages}
        </span>
        <AppButton
          variant="secondary"
          size="xs"
          disabled={page >= totalPages}
          onClick={() => props.onPageChange(page + 1)}
          trailingIcon={<ChevronRight className="h-3.5 w-3.5" />}
        >
          下一页
        </AppButton>
      </div>
    </div>
  );
}

/** `AdminConfirmModal` 入参属性 */
export interface AdminConfirmModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel?: string | undefined;
  readonly cancelLabel?: string | undefined;
  readonly variant?: "danger" | "primary" | undefined;
  readonly isPending?: boolean | undefined;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly children?: ReactNode | undefined;
}

/**
 * 渲染后台危险/关键操作二次确认弹窗（基于 `AppModal` 适配桌面与移动端手势抽屉）。
 */
export function AdminConfirmModal(props: AdminConfirmModalProps) {
  return (
    <AppModal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      subtitle={props.description}
      maxWidthClass="max-w-md"
      footer={
        <div className="flex items-center justify-end gap-2">
          <AppButton
            variant="secondary"
            size="sm"
            disabled={props.isPending}
            onClick={props.onClose}
          >
            {props.cancelLabel ?? "取消"}
          </AppButton>
          <AppButton
            variant={props.variant ?? "danger"}
            size="sm"
            isLoading={props.isPending}
            onClick={props.onConfirm}
          >
            {props.confirmLabel ?? "确认执行"}
          </AppButton>
        </div>
      }
    >
      {props.children ?? (
        <p className="text-[13px] leading-relaxed text-[#3B414E] dark:text-[#B4BCD0]">
          {props.description}
        </p>
      )}
    </AppModal>
  );
}

/**
 * 渲染表格区域加载骨架态。
 */
export function AdminTableSkeleton(props: { readonly rows?: number | undefined }) {
  const count = props.rows ?? 5;
  return (
    <div className="space-y-2.5 p-4">
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={`adm-sk-${String(idx)}`}
          className="flex items-center gap-3 rounded-xl bg-black/[0.025] px-3.5 py-3 dark:bg-white/[0.03]"
        >
          <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-black/[0.07] dark:bg-white/[0.08]" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3.5 w-1/3 animate-pulse rounded bg-black/[0.07] dark:bg-white/[0.08]" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-black/[0.05] dark:bg-white/[0.05]" />
          </div>
          <div className="h-6 w-16 shrink-0 animate-pulse rounded-full bg-black/[0.06] dark:bg-white/[0.06]" />
        </div>
      ))}
    </div>
  );
}

/**
 * 渲染列表无数据空状态引导卡片。
 */
export function AdminEmptyState(props: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly action?: ReactNode | undefined;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-black/[0.04] text-[#687082] dark:bg-white/[0.06] dark:text-[#8E96AB]">
        <Inbox className="h-5 w-5" />
      </div>
      <h3 className="mt-3 text-[14px] font-semibold text-[#111318] dark:text-[#ECEFF6]">
        {props.title}
      </h3>
      {props.description !== undefined ? (
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-[#687082] dark:text-[#7D869C]">
          {props.description}
        </p>
      ) : null}
      {props.action !== undefined ? <div className="mt-4">{props.action}</div> : null}
    </div>
  );
}

/**
 * 渲染查询出错重试卡片。
 */
export function AdminErrorState(props: {
  readonly title?: string | undefined;
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="m-4 rounded-2xl border border-[#E5484D]/20 bg-[#E5484D]/8 p-5 text-center dark:border-[#F05252]/25 dark:bg-[#F05252]/12">
      <AlertCircle className="mx-auto h-6 w-6 text-[#D70015] dark:text-[#FF6961]" />
      <h3 className="mt-2 text-sm font-semibold text-[#111318] dark:text-[#ECEFF6]">
        {props.title ?? "数据加载失败"}
      </h3>
      <p className="mt-1 text-xs text-[#687082] dark:text-[#B4BCD0]">{props.message}</p>
      <div className="mt-3.5 flex justify-center">
        <AppButton
          variant="danger"
          size="xs"
          leadingIcon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={props.onRetry}
        >
          重试加载
        </AppButton>
      </div>
    </div>
  );
}
