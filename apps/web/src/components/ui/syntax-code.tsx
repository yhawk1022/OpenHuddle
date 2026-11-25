/**
 * @module web/components/ui/syntax-code
 * @description 原生桌面级（Xcode 16 / Tower 中性双主题）语法高亮渲染原语，同时服务工作台 Unified Diff 与聊天代码块。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 调色板克制且正交：关键字采用深梅紫（`#9B2393` / `dark:#F087BD`），即使在 Diff 新增绿底或删除红底上也绝不与底色混同；
 *    函数名采用静谧钴蓝，类型采用深青，字符串采用暖赤陶，注释采用柔和石板灰。
 * 2. 兼容反色气泡（`inverted`）：当代码块处于反色深底表面时自动切换高亮度浅色调色板，保持对比度安全。
 */
import { useMemo } from "react";
import { cn } from "../../lib/cn.js";
import {
  type SyntaxLanguage,
  type SyntaxToken,
  type SyntaxTokenKind,
  tokenizeCodeBlock,
} from "../../lib/syntax-highlight.js";

const DEFAULT_TOKEN_CLASS: Record<SyntaxTokenKind, string> = {
  plain: "text-[#181B22] dark:text-[#E6E8EE]",
  keyword: "font-medium text-[#9B2393] dark:text-[#F087BD]",
  type: "text-[#0B617D] dark:text-[#6BDFFF]",
  function: "text-[#2952B3] dark:text-[#82AAFF]",
  string: "text-[#B43E24] dark:text-[#FFA67A]",
  number: "text-[#1D4ED8] dark:text-[#D4A5FF]",
  comment: "italic text-[#6A737D] dark:text-[#7E8691]",
  doc_tag: "font-medium not-italic text-[#5B4B8A] dark:text-[#B8A9F0]",
  property: "text-[#1E5F5B] dark:text-[#7EE787]",
  operator: "text-[#4B5565] dark:text-[#9DA5B4]",
  punctuation: "text-[#57606A] dark:text-[#8E96A6]",
  diff_add: "text-[#15803D] dark:text-[#4ADE80]",
  diff_del: "text-[#B91C1C] dark:text-[#F87171]",
  diff_hunk: "text-[#4338CA] dark:text-[#93C5FD]",
};

const INVERTED_TOKEN_CLASS: Record<SyntaxTokenKind, string> = {
  plain: "text-white/95",
  keyword: "font-medium text-[#F9A8D4]",
  type: "text-[#7DD3FC]",
  function: "text-[#93C5FD]",
  string: "text-[#FDBA74]",
  number: "text-[#DDD6FE]",
  comment: "italic text-white/55",
  doc_tag: "font-medium not-italic text-[#C4B5FD]",
  property: "text-[#86EFAC]",
  operator: "text-white/75",
  punctuation: "text-white/70",
  diff_add: "text-[#86EFAC]",
  diff_del: "text-[#FCA5A5]",
  diff_hunk: "text-[#93C5FD]",
};

/** `HighlightedTokenLine` 入参属性 */
export interface HighlightedTokenLineProps {
  readonly tokens: ReadonlyArray<SyntaxToken>;
  readonly inverted?: boolean | undefined;
}

/**
 * 渲染单行已分词的语法高亮 `<span>` 序列。空行返回 `null`，由外层块容器控制换行。
 */
export function HighlightedTokenLine(props: HighlightedTokenLineProps) {
  const palette = props.inverted ? INVERTED_TOKEN_CLASS : DEFAULT_TOKEN_CLASS;
  if (props.tokens.length === 0) {
    return null;
  }
  let offset = 0;
  return (
    <>
      {props.tokens.map((tok) => {
        const key = `${String(offset)}:${tok.kind}`;
        offset += tok.text.length;
        return (
          <span key={key} className={palette[tok.kind]}>
            {tok.text}
          </span>
        );
      })}
    </>
  );
}

/** `HighlightedCodeBlock` 入参属性 */
export interface HighlightedCodeBlockProps {
  readonly code: string;
  readonly language: SyntaxLanguage;
  readonly inverted?: boolean | undefined;
  readonly className?: string | undefined;
}

/**
 * 渲染完整多行语法高亮代码块（供 Markdown `CodeFenceBlock` 等组件直接调用）。
 */
export function HighlightedCodeBlock(props: HighlightedCodeBlockProps) {
  const keyedLines = useMemo(() => {
    const rawLines = tokenizeCodeBlock(props.code, props.language);
    let charCursor = 0;
    return rawLines.map((tokens, index) => {
      const lineLen = tokens.reduce((acc, t) => acc + t.text.length, 0);
      const lineKey = `ln-${String(charCursor)}`;
      charCursor += lineLen + 1;
      return {
        lineKey,
        tokens,
        hasNewline: index < rawLines.length - 1,
      };
    });
  }, [props.code, props.language]);

  return (
    <code className={cn("font-mono", props.className)}>
      {keyedLines.map((line) => (
        <span key={line.lineKey}>
          <HighlightedTokenLine tokens={line.tokens} inverted={props.inverted} />
          {line.hasNewline ? "\n" : null}
        </span>
      ))}
    </code>
  );
}
