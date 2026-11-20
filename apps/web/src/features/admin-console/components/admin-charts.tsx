/**
 * @module web/features/admin-console/charts
 * @description 零重型依赖的定制交互式 SVG 趋势图与分布条形图组件（严格适配 Atelier Daylight & Obsidian Studio 双主题）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 纯矢量轻量零依赖：无需引入大型图表库（如 Recharts/ECharts），保障 2C4G 容器构建轻量与零 SSR/StrictMode 副作用。
 * 2. 精确悬停交互：支持鼠标滑过/点击日期列查看单日人类消息、Agent 消息、新用户、新房间与新提案明细。
 */
import type { AdminDailyTrendPoint, AdminDistributionEntry } from "@openhuddle/protocol";
import { useId, useState } from "react";
import { type SegmentedTabItem, SegmentedTabs, cn } from "../../../components/primitives/index.js";

type TrendChartMetricMode = "messages" | "growth";

const METRIC_MODE_TABS: ReadonlyArray<SegmentedTabItem<TrendChartMetricMode>> = [
  { value: "messages", label: "消息活跃 (人类 / Agent)" },
  { value: "growth", label: "新增实体 (用户 / 群聊 / 提案)" },
];

/**
 * 渲染后台大盘每日多维趋势交互图表卡片。
 */
export function AdminTrendChartCard(props: {
  readonly points: ReadonlyArray<AdminDailyTrendPoint>;
  readonly windowDays: number;
}) {
  const [mode, setMode] = useState<TrendChartMetricMode>("messages");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const gradId = useId();

  const points = props.points;
  const maxVal = Math.max(
    1,
    ...points.map((p) =>
      mode === "messages" ? p.totalMessages : Math.max(p.newUsers, p.newRooms, p.newProposals),
    ),
  );

  const svgWidth = 720;
  const svgHeight = 210;
  const padLeft = 36;
  const padRight = 14;
  const padTop = 16;
  const padBottom = 28;
  const innerWidth = svgWidth - padLeft - padRight;
  const innerHeight = svgHeight - padTop - padBottom;

  const getX = (index: number): number => {
    if (points.length <= 1) {
      return padLeft + innerWidth / 2;
    }
    return padLeft + (index / (points.length - 1)) * innerWidth;
  };

  const getY = (val: number): number => {
    const ratio = Math.min(1, Math.max(0, val / maxVal));
    return padTop + innerHeight - ratio * innerHeight;
  };

  const buildPolyline = (accessor: (p: AdminDailyTrendPoint) => number): string =>
    points.map((p, idx) => `${getX(idx).toFixed(1)},${getY(accessor(p)).toFixed(1)}`).join(" ");

  const buildAreaPath = (accessor: (p: AdminDailyTrendPoint) => number): string => {
    if (points.length === 0) {
      return "";
    }
    const lineCoords = points
      .map(
        (p, idx) =>
          `${idx === 0 ? "M" : "L"}${getX(idx).toFixed(1)} ${getY(accessor(p)).toFixed(1)}`,
      )
      .join(" ");
    const lastX = getX(points.length - 1).toFixed(1);
    const firstX = getX(0).toFixed(1);
    const baseY = (padTop + innerHeight).toFixed(1);
    return `${lineCoords} L${lastX} ${baseY} L${firstX} ${baseY} Z`;
  };

  const activeIndex = hoverIdx !== null && hoverIdx < points.length ? hoverIdx : points.length - 1;
  const activePoint = points[activeIndex];

  const yTicks = [0, Math.round(maxVal / 2), maxVal];
  const labelStride = Math.max(1, Math.ceil(points.length / 6));

  return (
    <section className="oh-elevated-card flex flex-col justify-between rounded-2xl p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[14.5px] font-semibold tracking-[-0.01em] text-[#111318] dark:text-[#ECEFF6]">
            近 {props.windowDays} 天平台活跃与增长趋势
          </h3>
          <p className="mt-0.5 text-xs text-[#687082] dark:text-[#7D869C]">
            按 UTC 自然日聚合，悬停任意日期列查看人机交互精确明细
          </p>
        </div>

        <SegmentedTabs
          value={mode}
          onValueChange={setMode}
          items={METRIC_MODE_TABS}
          size="xs"
          ariaLabel="切换趋势图统计指标"
        />
      </div>

      {/* 当前焦点日期摘要条 */}
      {activePoint !== undefined ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl bg-black/[0.03] px-3 py-2 text-xs dark:bg-white/[0.04]">
          <span className="font-mono font-semibold text-[#111318] dark:text-[#ECEFF6]">
            {activePoint.date}
          </span>
          {mode === "messages" ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-[#3B414E] dark:text-[#B4BCD0]">
                <span className="h-2 w-2 rounded-full bg-[#181B22] dark:bg-[#ECEFF6]" />
                总消息 <strong className="tabular-nums">{activePoint.totalMessages}</strong>
              </span>
              <span className="inline-flex items-center gap-1.5 text-[#3B414E] dark:text-[#B4BCD0]">
                <span className="h-2 w-2 rounded-full bg-[#16A34A] dark:bg-[#34D399]" />
                人类发言 <strong className="tabular-nums">{activePoint.humanMessages}</strong>
              </span>
              <span className="inline-flex items-center gap-1.5 text-[#3B414E] dark:text-[#B4BCD0]">
                <span className="h-2 w-2 rounded-full bg-[#2563EB] dark:bg-[#60A5FA]" />
                Agent 发言 <strong className="tabular-nums">{activePoint.agentMessages}</strong>
              </span>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5 text-[#3B414E] dark:text-[#B4BCD0]">
                <span className="h-2 w-2 rounded-full bg-[#181B22] dark:bg-[#ECEFF6]" />
                新用户 <strong className="tabular-nums">{activePoint.newUsers}</strong>
              </span>
              <span className="inline-flex items-center gap-1.5 text-[#3B414E] dark:text-[#B4BCD0]">
                <span className="h-2 w-2 rounded-full bg-[#16A34A] dark:bg-[#34D399]" />
                新群聊 <strong className="tabular-nums">{activePoint.newRooms}</strong>
              </span>
              <span className="inline-flex items-center gap-1.5 text-[#3B414E] dark:text-[#B4BCD0]">
                <span className="h-2 w-2 rounded-full bg-[#D97706] dark:bg-[#FBBF24]" />
                新提案 <strong className="tabular-nums">{activePoint.newProposals}</strong>
              </span>
            </>
          )}
        </div>
      ) : null}

      <div className="mt-3 w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${String(svgWidth)} ${String(svgHeight)}`}
          className="h-[200px] w-full select-none"
          role="img"
          aria-label={`近 ${String(props.windowDays)} 天平台趋势图`}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id={`area-${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {/* 水平参考网格线与 Y 轴刻度 */}
          {yTicks.map((tickVal, idx) => {
            const y = getY(tickVal);
            return (
              <g key={`ytick-${String(idx)}`}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={svgWidth - padRight}
                  y2={y}
                  className="stroke-black/[0.06] dark:stroke-white/[0.07]"
                  strokeDasharray="3 3"
                />
                <text
                  x={padLeft - 6}
                  y={y + 3.5}
                  textAnchor="end"
                  className="fill-[#939BAD] text-[10px] tabular-nums dark:fill-[#687082]"
                >
                  {tickVal}
                </text>
              </g>
            );
          })}

          {/* 焦点列高亮指示线 */}
          {activePoint !== undefined ? (
            <line
              x1={getX(activeIndex)}
              y1={padTop}
              x2={getX(activeIndex)}
              y2={padTop + innerHeight}
              className="stroke-black/[0.15] dark:stroke-white/[0.18]"
              strokeWidth="1"
            />
          ) : null}

          {mode === "messages" ? (
            <>
              {points.length > 0 ? (
                <path
                  d={buildAreaPath((p) => p.totalMessages)}
                  fill={`url(#area-${gradId})`}
                  className="text-[#181B22] dark:text-[#ECEFF6]"
                />
              ) : null}
              <polyline
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={buildPolyline((p) => p.totalMessages)}
                className="stroke-[#181B22] dark:stroke-[#ECEFF6]"
              />
              <polyline
                fill="none"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={buildPolyline((p) => p.humanMessages)}
                className="stroke-[#16A34A] dark:stroke-[#34D399]"
              />
              <polyline
                fill="none"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="4 3"
                points={buildPolyline((p) => p.agentMessages)}
                className="stroke-[#2563EB] dark:stroke-[#60A5FA]"
              />
            </>
          ) : (
            <>
              <polyline
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={buildPolyline((p) => p.newUsers)}
                className="stroke-[#181B22] dark:stroke-[#ECEFF6]"
              />
              <polyline
                fill="none"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={buildPolyline((p) => p.newRooms)}
                className="stroke-[#16A34A] dark:stroke-[#34D399]"
              />
              <polyline
                fill="none"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={buildPolyline((p) => p.newProposals)}
                className="stroke-[#D97706] dark:stroke-[#FBBF24]"
              />
            </>
          )}

          {/* X 轴日期标签 */}
          {points.map((p, idx) => {
            if (idx % labelStride !== 0 && idx !== points.length - 1) {
              return null;
            }
            return (
              <text
                key={`x-${p.date}`}
                x={getX(idx)}
                y={svgHeight - 8}
                textAnchor="middle"
                className="fill-[#687082] text-[10px] tabular-nums dark:fill-[#7D869C]"
              >
                {p.date.slice(5)}
              </text>
            );
          })}

          {/* 悬停热点点与交互热区 */}
          {points.map((p, idx) => {
            const x = getX(idx);
            const yMain = getY(mode === "messages" ? p.totalMessages : p.newUsers);
            const sliceWidth = points.length <= 1 ? innerWidth : innerWidth / (points.length - 1);
            const isSelected = idx === activeIndex;
            return (
              <g key={`hit-${p.date}`}>
                {isSelected ? (
                  <circle
                    cx={x}
                    cy={yMain}
                    r={4}
                    className="fill-[#181B22] stroke-white stroke-[1.5] dark:fill-[#ECEFF6] dark:stroke-[#151821]"
                  />
                ) : null}
                <rect
                  x={x - sliceWidth / 2}
                  y={padTop}
                  width={Math.max(12, sliceWidth)}
                  height={innerHeight + 16}
                  fill="transparent"
                  role="button"
                  tabIndex={0}
                  aria-label={`查看 ${p.date} 趋势数据`}
                  className="cursor-crosshair outline-none focus-visible:stroke-[#181B22]/40 dark:focus-visible:stroke-white/40"
                  onMouseEnter={() => setHoverIdx(idx)}
                  onFocus={() => setHoverIdx(idx)}
                  onClick={() => setHoverIdx(idx)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setHoverIdx(idx);
                    }
                  }}
                />
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

/**
 * 渲染横向比例分布条形统计卡（适用于 Agent 平台、可达状态与治理模式占比）。
 */
export function AdminBreakdownCard(props: {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly entries: ReadonlyArray<AdminDistributionEntry>;
  readonly accentMap?: Readonly<Record<string, string>> | undefined;
}) {
  const total = props.entries.reduce((acc, item) => acc + item.count, 0);

  return (
    <section className="oh-elevated-card flex flex-col justify-between rounded-2xl p-4 sm:p-5">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[14px] font-semibold text-[#111318] dark:text-[#ECEFF6]">
            {props.title}
          </h3>
          <span className="text-xs font-medium text-[#687082] tabular-nums dark:text-[#7D869C]">
            总计 {total}
          </span>
        </div>
        {props.subtitle !== undefined ? (
          <p className="mt-0.5 text-xs text-[#687082] dark:text-[#7D869C]">{props.subtitle}</p>
        ) : null}
      </div>

      {props.entries.length === 0 || total === 0 ? (
        <p className="py-6 text-center text-xs text-[#939BAD] dark:text-[#63636B]">暂无分布数据</p>
      ) : (
        <div className="mt-4 space-y-2.5">
          {props.entries.map((entry) => {
            const pct = total > 0 ? Math.round((entry.count / total) * 100) : 0;
            const barClass = props.accentMap?.[entry.key] ?? "bg-[#181B22]/80 dark:bg-[#ECEFF6]/80";
            return (
              <div key={entry.key} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate font-medium text-[#3B414E] dark:text-[#B4BCD0]">
                    {entry.label}
                  </span>
                  <span className="shrink-0 font-mono text-[11.5px] text-[#687082] tabular-nums dark:text-[#8E96AB]">
                    {entry.count} ({pct}%)
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.06]">
                  <div
                    className={cn("h-full rounded-full transition-all duration-300", barClass)}
                    style={{ width: `${String(Math.max(entry.count > 0 ? 4 : 0, pct))}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
