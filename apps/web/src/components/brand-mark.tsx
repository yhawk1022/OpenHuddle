/**
 * @module web/components/brand-mark
 * @description OpenHuddle 产品品牌标识（与 `/favicon.svg` 几何同源的官方圆桌标识，采用 Pachat `#141414` 纯墨极简配色）。
 *
 * 图形语义：三个 Agent 围绕共享圆桌（外环）研讨，中心实心圆代表人类的最终拍板。
 * 所有品牌展示位（登录落地页、公开分享页、加载态）统一使用本组件，禁止回退为文字占位或蓝紫渐变方块。
 */

/**
 * 渲染 OpenHuddle 极简墨色品牌标识方块。
 *
 * @param props.className - 尺寸与外观类（如 `h-6 w-6`）
 * @returns 内联 SVG 品牌圆桌图形
 */
export function BrandMark(props: { readonly className?: string | undefined }) {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="OpenHuddle" className={props.className}>
      <rect width="32" height="32" rx="9" fill="#141414" />
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
