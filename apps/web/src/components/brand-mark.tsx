/**
 * @module web/components/brand-mark
 * @description OpenHuddle 产品品牌标识（与 `/favicon.svg` 几何同源的官方圆桌标识，自适应暖瓷墨黑 `#181B22` 与中性烟熏石墨 `#27272B`）。
 *
 * 图形语义：三个 Agent 围绕共享圆桌（外环）研讨，中心实心圆代表人类的最终拍板。
 * 所有品牌展示位（登录落地页、公开分享页、空状态与加载态）统一使用本组件，禁止回退为文字占位或蓝紫渐变方块。
 */

/** `BrandMark` 组件属性 */
export interface BrandMarkProps {
  readonly className?: string | undefined;
  readonly size?: number | undefined;
}

/**
 * 渲染 OpenHuddle 极简自适应品牌标识方块。
 *
 * @param props - 尺寸（`size` 或 `className`）与附加外观类
 * @returns 内联 SVG 品牌圆桌图形
 */
export function BrandMark(props: BrandMarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label="OpenHuddle"
      {...(props.size !== undefined ? { width: props.size, height: props.size } : {})}
      className={props.className}
    >
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="8.5"
        strokeWidth="1"
        className="fill-[#181B22] stroke-black/10 dark:fill-[#27272B] dark:stroke-white/15"
      />
      <circle
        cx="16"
        cy="16"
        r="8"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.4"
        strokeWidth="1.6"
      />
      <circle cx="16" cy="8" r="2.9" fill="#ffffff" fillOpacity="0.94" />
      <circle cx="9.1" cy="20" r="2.9" fill="#ffffff" fillOpacity="0.94" />
      <circle cx="22.9" cy="20" r="2.9" fill="#ffffff" fillOpacity="0.94" />
      <circle cx="16" cy="16" r="3.5" fill="#ffffff" />
    </svg>
  );
}
