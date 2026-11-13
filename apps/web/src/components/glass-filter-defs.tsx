/**
 * @module web/components/glass-filter-defs
 * @description Liquid Glass 液态折射滤镜定义（全局挂载一次，供 `backdrop-filter: url(#oh-refract)` 引用）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 液态位移：`feTurbulence` 低频分形噪声经 `feGaussianBlur` 平滑后作为位移场，
 *    `feDisplacementMap` 让面板背后的背景发生随位置连续变化的有机弯折——"液态"质感来源。
 *    仅扭曲背景（backdrop），面板自身文字与内容不受影响。
 * 2. 平台铁律（Chromium 实测）：backdrop-filter 的 url() 滤镜在合成器管线中**不执行 feImage**
 *    （外部 PNG / data URI 均被加载为空图 → 全图均匀位移），位移场必须由滤镜图内部原语
 *    （feTurbulence 等）生成；本组件不得引入 feImage。
 * 3. 色彩空间：`color-interpolation-filters` 必须为 `sRGB`，否则噪声通道值经 linearRGB
 *    换算后位移方向整体偏置。
 * 4. 降级契约：不支持的浏览器经 styles.css 双声明级联回落到纯 `blur + saturate`；
 *    本组件输出零可视面积（`width/height=0` + `position:absolute`）。
 */
/**
 * 渲染挂载于文档流的隐藏 SVG 滤镜定义。
 *
 * @returns 零尺寸的 SVG 滤镜宿主元素
 */
export function GlassFilterDefs() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
      style={{ position: "absolute", pointerEvents: "none" }}
    >
      <filter
        id="oh-refract"
        x="-20%"
        y="-20%"
        width="140%"
        height="140%"
        colorInterpolationFilters="sRGB"
      >
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.009 0.016"
          numOctaves={2}
          seed={7}
          result="noise"
        />
        <feGaussianBlur in="noise" stdDeviation={7} result="soft" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="soft"
          scale={64}
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}
