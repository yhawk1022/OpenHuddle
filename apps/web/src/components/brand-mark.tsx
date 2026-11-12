/**
 * @module web/components/brand-mark
 * @description OpenHuddle 产品品牌标识（与 `/favicon.svg` 同源的官方图形）。
 *
 * 图形语义：三个 Agent 围绕共享圆桌（外环）研讨，中心实心圆代表人类的最终拍板。
 * 所有品牌展示位（侧边栏、登录页、公开分享页、加载态）统一使用本组件，禁止回退为文字占位。
 */

/**
 * 渲染 OpenHuddle 品牌标识方块。
 *
 * @param props.className - 尺寸与阴影等外观类（如 `h-8 w-8 shadow-xs`），图形自带渐变底色与圆角。
 * @returns 与站点 favicon 完全一致的内联 SVG 品牌方块
 */
export function BrandMark(props: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="OpenHuddle" className={props.className}>
      <defs>
        <linearGradient
          id="oh-brand-gradient"
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#oh-brand-gradient)" />
      <circle
        cx="16"
        cy="16"
        r="8"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.38"
        strokeWidth="1.6"
      />
      <circle cx="16" cy="8" r="2.9" fill="#ffffff" fillOpacity="0.92" />
      <circle cx="9.1" cy="20" r="2.9" fill="#ffffff" fillOpacity="0.92" />
      <circle cx="22.9" cy="20" r="2.9" fill="#ffffff" fillOpacity="0.92" />
      <circle cx="16" cy="16" r="3.5" fill="#ffffff" />
    </svg>
  );
}
