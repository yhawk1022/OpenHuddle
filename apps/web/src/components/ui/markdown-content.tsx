/**
 * @module web/components/ui/markdown-content
 * @description 聊天与提案受限子集 Markdown 渲染组件（解析为受控 React 节点树输出，禁用原始 HTML）。
 *
 * 关键不变量：
 * 1. 防 XSS 边界：所有群聊消息均按不可信输入处理，外部超链接仅放行 `http:` / `https:` 协议。
 * 2. 防零点击外带与 IP 探测：聊天 Markdown 严禁将 `![alt](url)` 渲染为自动发起网络请求的 `<img>` 元素，安全 `http(s)` 图片语法统一降级为显式点击的 `<a target="_blank" rel="noopener noreferrer">` 外链，非法协议降级为纯文本。
 * 3. 渲染缓存：对 `parseMarkdownBlocks` 结果按 `content` 做引用级缓存，避免父容器时钟刷新触发全时间线重复解析。
 */
import { assertNever } from "@openhuddle/protocol";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  formatCodeFenceLanguageLabel,
  resolveCodeBlockSyntaxLanguage,
} from "../../lib/syntax-highlight.js";
import { useComponentsI18n } from "../i18n/index.js";
import { AppTooltip, IconButton, cn, toast } from "../primitives/index.js";
import { HighlightedCodeBlock } from "./syntax-code.js";

/** Markdown 渲染色调：`default` = 标准浅/深双主题气泡；`inverted` = 深底反白兼容色调 */
export type MarkdownTone = "default" | "inverted";

/** `MarkdownContent` 组件入参属性 */
export interface MarkdownContentProps {
  readonly content: string;
  readonly className?: string | undefined;
  /** 渲染色调，缺省为 `default` */
  readonly tone?: MarkdownTone | undefined;
}

type TableAlign = "left" | "center" | "right";

type MarkdownBlock =
  | {
      readonly id: string;
      readonly kind: "code";
      readonly language: string;
      readonly code: string;
    }
  | {
      readonly id: string;
      readonly kind: "heading";
      readonly level: 1 | 2 | 3 | 4;
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly kind: "blockquote";
      readonly lines: ReadonlyArray<string>;
    }
  | {
      readonly id: string;
      readonly kind: "ul";
      readonly items: ReadonlyArray<string>;
    }
  | {
      readonly id: string;
      readonly kind: "ol";
      readonly items: ReadonlyArray<string>;
    }
  | {
      readonly id: string;
      readonly kind: "table";
      readonly headers: ReadonlyArray<string>;
      readonly alignments: ReadonlyArray<TableAlign>;
      readonly rows: ReadonlyArray<ReadonlyArray<string>>;
    }
  | {
      readonly id: string;
      readonly kind: "hr";
    }
  | {
      readonly id: string;
      readonly kind: "paragraph";
      readonly lines: ReadonlyArray<string>;
    };

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) {
    return false;
  }
  const cells = splitTableRow(trimmed);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return stripped.split("|").map((cell) => cell.trim());
}

function parseTableAlignments(separatorLine: string): TableAlign[] {
  return splitTableRow(separatorLine).map((raw) => {
    const cell = raw.trim();
    if (cell.startsWith(":") && cell.endsWith(":")) {
      return "center";
    }
    if (cell.endsWith(":")) {
      return "right";
    }
    return "left";
  });
}

function parseMarkdownBlocks(raw: string): ReadonlyArray<MarkdownBlock> {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: MarkdownBlock[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor] ?? "";
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      cursor += 1;
      continue;
    }

    // 1. 围栏代码块 ```lang 或 ~~~lang（支持 3 个及以上反引号/波浪号，避免内嵌三反引号提前闭合）
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (fenceMatch !== null) {
      const startLine = cursor;
      const fenceMarker = fenceMatch[1] ?? "```";
      const fenceChar = fenceMarker[0] ?? "`";
      const fenceMinLen = fenceMarker.length;
      const language = (fenceMatch[2] ?? "").trim();
      const closeFenceRegex = new RegExp(`^\\${fenceChar}{${String(fenceMinLen)},}\\s*$`);
      cursor += 1;
      const codeLines: string[] = [];
      while (cursor < lines.length) {
        const current = lines[cursor] ?? "";
        if (closeFenceRegex.test(current.trim())) {
          cursor += 1;
          break;
        }
        codeLines.push(current);
        cursor += 1;
      }
      blocks.push({
        id: `code-${startLine}`,
        kind: "code",
        language,
        code: codeLines.join("\n"),
      });
      continue;
    }

    // 2. 分割线 --- / ***
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push({ id: `hr-${cursor}`, kind: "hr" });
      cursor += 1;
      continue;
    }

    // 3. 标题 # .. ####
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch !== null) {
      const hashes = headingMatch[1] ?? "#";
      const text = headingMatch[2] ?? "";
      const level = Math.min(4, Math.max(1, hashes.length)) as 1 | 2 | 3 | 4;
      blocks.push({
        id: `hd-${cursor}`,
        kind: "heading",
        level,
        text,
      });
      cursor += 1;
      continue;
    }

    // 4. GFM 对比表格 | Header | Header | + | --- | --- |
    const nextLine = lines[cursor + 1];
    if (line.includes("|") && nextLine !== undefined && isTableSeparatorLine(nextLine)) {
      const startLine = cursor;
      const headers = splitTableRow(line);
      const alignments = parseTableAlignments(nextLine);
      cursor += 2;
      const rows: string[][] = [];
      while (cursor < lines.length) {
        const rowLine = lines[cursor] ?? "";
        if (rowLine.trim().length === 0 || !rowLine.includes("|")) {
          break;
        }
        rows.push(splitTableRow(rowLine));
        cursor += 1;
      }
      blocks.push({
        id: `tbl-${startLine}`,
        kind: "table",
        headers,
        alignments,
        rows,
      });
      continue;
    }

    // 5. 引用块 > ...
    if (trimmed.startsWith(">")) {
      const startLine = cursor;
      const quoteLines: string[] = [];
      while (cursor < lines.length) {
        const qLine = (lines[cursor] ?? "").trim();
        if (!qLine.startsWith(">")) {
          break;
        }
        quoteLines.push(qLine.replace(/^>\s?/, ""));
        cursor += 1;
      }
      blocks.push({
        id: `bq-${startLine}`,
        kind: "blockquote",
        lines: quoteLines,
      });
      continue;
    }

    // 6. 无序列表 - / *
    if (/^[-*]\s+/.test(trimmed)) {
      const startLine = cursor;
      const items: string[] = [];
      while (cursor < lines.length) {
        const itemLine = (lines[cursor] ?? "").trim();
        const match = /^[-*]\s+(.+)$/.exec(itemLine);
        if (!match || match[1] === undefined) {
          break;
        }
        items.push(match[1]);
        cursor += 1;
      }
      blocks.push({
        id: `ul-${startLine}`,
        kind: "ul",
        items,
      });
      continue;
    }

    // 7. 有序列表 1. / 2.
    if (/^\d+\.\s+/.test(trimmed)) {
      const startLine = cursor;
      const items: string[] = [];
      while (cursor < lines.length) {
        const itemLine = (lines[cursor] ?? "").trim();
        const match = /^\d+\.\s+(.+)$/.exec(itemLine);
        if (!match || match[1] === undefined) {
          break;
        }
        items.push(match[1]);
        cursor += 1;
      }
      blocks.push({
        id: `ol-${startLine}`,
        kind: "ol",
        items,
      });
      continue;
    }

    // 8. 普通段落（合并连续非特殊行）
    const startLine = cursor;
    const paraLines: string[] = [];
    while (cursor < lines.length) {
      const pLine = lines[cursor] ?? "";
      const pTrim = pLine.trim();
      if (
        pTrim.length === 0 ||
        pTrim.startsWith("```") ||
        pTrim.startsWith("~~~") ||
        pTrim.startsWith(">") ||
        /^#{1,4}\s+/.test(pTrim) ||
        /^[-*]\s+/.test(pTrim) ||
        /^\d+\.\s+/.test(pTrim) ||
        /^(-{3,}|\*{3,})$/.test(pTrim) ||
        (pLine.includes("|") &&
          lines[cursor + 1] !== undefined &&
          isTableSeparatorLine(lines[cursor + 1] ?? ""))
      ) {
        break;
      }
      paraLines.push(pLine);
      cursor += 1;
    }
    blocks.push({
      id: `p-${startLine}`,
      kind: "paragraph",
      lines: paraLines,
    });
  }

  return blocks;
}

/**
 * 校验外部超链接是否属于安全的 HTTP/HTTPS 协议，阻断 `javascript:` / `data:` 伪协议 XSS。
 */
function sanitizeSafeHttpUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

interface MarkdownToneStyles {
  readonly rootText: string;
  readonly inlineCode: string;
  readonly strong: string;
  readonly em: string;
  readonly link: string;
  readonly mention: string;
  readonly hr: string;
  readonly headingStrong: string;
  readonly headingSoft: string;
  readonly blockquote: string;
  readonly tableWrap: string;
  readonly tableDivide: string;
  readonly thead: string;
  readonly tbody: string;
  readonly rowHover: string;
  readonly td: string;
  readonly codeFence: string;
  readonly codeHeader: string;
  readonly codeBody: string;
}

const DEFAULT_TONE: MarkdownToneStyles = {
  rootText: "text-inherit",
  inlineCode:
    "rounded-[5px] bg-black/[0.05] px-1.5 py-[1px] font-mono text-[0.86em] text-[#111318] ring-1 ring-inset ring-black/[0.06] dark:bg-white/[0.08] dark:text-[#ECEFF6] dark:ring-white/[0.09]",
  strong: "font-semibold text-[#111318] dark:text-white",
  em: "italic opacity-90",
  link: "font-medium text-[#2563EB] underline decoration-[#2563EB]/35 underline-offset-[3px] transition-colors hover:decoration-[#2563EB] dark:text-[#60A5FA] dark:decoration-[#60A5FA]/40",
  mention:
    "rounded-[5px] bg-emerald-600/[0.09] px-1 py-px font-medium text-[#0E7B52] dark:bg-emerald-400/[0.13] dark:text-[#5EE0A8]",
  hr: "my-2.5 border-t border-black/[0.07] dark:border-white/[0.08]",
  headingStrong: "text-[#111318] dark:text-white",
  headingSoft: "text-[#111318] dark:text-[#ECEFF6]",
  blockquote:
    "border-l-2 border-black/15 pl-3 py-0.5 text-[14px] text-[#687082] dark:border-white/20 dark:text-[#9BA5BE]",
  tableWrap: "bg-[#F6F8FB]/75 ring-1 ring-black/[0.06] dark:bg-[#141417]/75 dark:ring-white/[0.08]",
  tableDivide: "divide-black/[0.06] dark:divide-white/[0.07]",
  thead: "bg-black/[0.03] text-[#111318] dark:bg-white/[0.04] dark:text-[#F2F2F4]",
  tbody: "bg-transparent",
  rowHover: "hover:bg-black/[0.025] dark:hover:bg-white/[0.03]",
  td: "text-[#3B414E] dark:text-[#C4C4CA]",
  codeFence:
    "bg-[#F6F8FB] ring-1 ring-inset ring-black/[0.06] dark:bg-[#141417] dark:ring-white/[0.08]",
  codeHeader:
    "border-b border-black/[0.06] bg-black/[0.02] text-[#687082] dark:border-white/[0.07] dark:bg-white/[0.03] dark:text-[#8E8E96]",
  codeBody: "text-[#111318] dark:text-[#F2F2F4]",
};

const INVERTED_TONE: MarkdownToneStyles = {
  rootText: "text-white",
  inlineCode:
    "rounded-[5px] bg-white/[0.16] px-1.5 py-[1px] font-mono text-[0.86em] text-white ring-1 ring-inset ring-white/20",
  strong: "font-semibold text-white",
  em: "italic text-white/95",
  link: "font-medium text-white underline decoration-white/55 underline-offset-[3px] transition-colors hover:decoration-white",
  mention: "font-medium text-[#86E0A6]",
  hr: "my-2.5 border-t border-white/20",
  headingStrong: "text-white",
  headingSoft: "text-white/95",
  blockquote: "border-l-2 border-white/60 pl-3 py-0.5 text-[14px] text-white/90",
  tableWrap: "bg-black/10 ring-1 ring-white/20",
  tableDivide: "divide-white/15",
  thead: "bg-white/[0.14] text-white",
  tbody: "bg-transparent",
  rowHover: "hover:bg-white/[0.07]",
  td: "text-white/92",
  codeFence: "bg-black/20 ring-1 ring-inset ring-white/15",
  codeHeader: "border-b border-white/15 text-white/75",
  codeBody: "text-white",
};

function getToneStyles(tone: MarkdownTone): MarkdownToneStyles {
  switch (tone) {
    case "default":
      return DEFAULT_TONE;
    case "inverted":
      return INVERTED_TONE;
    default:
      return assertNever(tone);
  }
}

const INLINE_TOKEN_REGEX =
  /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|!\[[^\]]*\]\([^)\n]+\)|\[[^\]]+\]\([^)\n]+\)|(?<![A-Za-z0-9._%+-])@[A-Za-z0-9_\-\u4e00-\u9fa5]+)/g;

function extractMarkdownTargetUrl(rawTarget: string): string {
  return rawTarget.replace(/\s+(?:"[^"]*"|'[^']*')$/u, "").trim();
}

interface InlineMarkdownLabels {
  readonly externalImageWithAlt: (alt: string) => string;
  readonly externalImageFallback: string;
}

function renderInlineMarkdown(
  text: string,
  keyPrefix: string,
  styles: MarkdownToneStyles,
  labels: InlineMarkdownLabels,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let tokenCounter = 0;

  for (const match of text.matchAll(INLINE_TOKEN_REGEX)) {
    const matchText = match[0];
    const matchIndex = match.index ?? 0;
    if (matchText === undefined) {
      continue;
    }

    if (matchIndex > lastIndex) {
      nodes.push(text.slice(lastIndex, matchIndex));
    }

    const tokenKey = `${keyPrefix}-tok-${tokenCounter}-${matchIndex}`;
    tokenCounter += 1;

    if (matchText.startsWith("`") && matchText.endsWith("`") && matchText.length >= 2) {
      nodes.push(
        <code key={tokenKey} className={styles.inlineCode}>
          {matchText.slice(1, -1)}
        </code>,
      );
    } else if (matchText.startsWith("**") && matchText.endsWith("**") && matchText.length >= 4) {
      nodes.push(
        <strong key={tokenKey} className={styles.strong}>
          {renderInlineMarkdown(matchText.slice(2, -2), `${tokenKey}-b`, styles, labels)}
        </strong>,
      );
    } else if (matchText.startsWith("*") && matchText.endsWith("*") && matchText.length >= 2) {
      nodes.push(
        <em key={tokenKey} className={styles.em}>
          {renderInlineMarkdown(matchText.slice(1, -1), `${tokenKey}-i`, styles, labels)}
        </em>,
      );
    } else if (matchText.startsWith("![")) {
      // 安全红线：严禁渲染任意外部 <img>（阻断零点击请求外带与客户端 IP 探测），仅对合法 http(s) 地址降级为安全显式外链
      const imgParts = /^!\[([^\]]*)\]\(([^)\n]+)\)$/.exec(matchText);
      const rawAlt = imgParts?.[1]?.trim() ?? "";
      const rawTarget = imgParts?.[2];
      const safeHref =
        rawTarget !== undefined ? sanitizeSafeHttpUrl(extractMarkdownTargetUrl(rawTarget)) : null;
      if (safeHref !== null) {
        const linkLabel =
          rawAlt.length > 0 ? labels.externalImageWithAlt(rawAlt) : labels.externalImageFallback;
        nodes.push(
          <a
            key={tokenKey}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
          >
            {linkLabel}
          </a>,
        );
      } else {
        nodes.push(matchText);
      }
    } else if (matchText.startsWith("[")) {
      const linkParts = /^\[([^\]]+)\]\(([^)\n]+)\)$/.exec(matchText);
      const label = linkParts?.[1];
      const rawHref = linkParts?.[2];
      const safeHref =
        rawHref !== undefined ? sanitizeSafeHttpUrl(extractMarkdownTargetUrl(rawHref)) : null;
      if (label !== undefined && safeHref !== null) {
        nodes.push(
          <a
            key={tokenKey}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
          >
            {renderInlineMarkdown(label, `${tokenKey}-a`, styles, labels)}
          </a>,
        );
      } else {
        // 安全边界：非 http/https 链接（如 `javascript:`）降级为纯文本，绝不生成可点击锚点
        nodes.push(matchText);
      }
    } else if (matchText.startsWith("@")) {
      nodes.push(
        <span key={tokenKey} className={styles.mention}>
          {matchText}
        </span>,
      );
    } else {
      nodes.push(matchText);
    }

    lastIndex = matchIndex + matchText.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

interface CodeFenceBlockProps {
  readonly language: string;
  readonly code: string;
  readonly styles: MarkdownToneStyles;
  readonly inverted: boolean;
}

function CodeFenceBlock(props: CodeFenceBlockProps) {
  const { t } = useComponentsI18n();
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const resolvedSyntaxLanguage = useMemo(
    () => resolveCodeBlockSyntaxLanguage(props.language, props.code),
    [props.language, props.code],
  );
  const headerLanguageLabel = useMemo(
    () => formatCodeFenceLanguageLabel(props.language, resolvedSyntaxLanguage),
    [props.language, resolvedSyntaxLanguage],
  );

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopy = (): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(props.code).then(() => {
      setCopied(true);
      toast.success(t("markdown.toastCodeCopied"));
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 1_800);
    });
  };

  return (
    <div className={cn("group/code my-2 overflow-hidden rounded-xl", props.styles.codeFence)}>
      <div
        className={cn(
          "flex select-none items-center justify-between px-3 py-1.5 text-[11.5px]",
          props.styles.codeHeader,
        )}
      >
        <span className="truncate font-mono text-[11px] font-medium lowercase tracking-wide">
          {headerLanguageLabel}
        </span>

        <AppTooltip content={copied ? t("markdown.copied") : t("markdown.copyCode")} side="top">
          <IconButton
            size="xs"
            variant="ghost"
            label={t("markdown.copyCode")}
            onClick={handleCopy}
            className="h-6 w-6 text-[#687082] hover:bg-black/[0.05] hover:text-[#111318] dark:text-[#7D869C] dark:hover:bg-white/[0.08] dark:hover:text-[#ECEFF6]"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-[#16A34A] dark:text-[#34D399]" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </IconButton>
        </AppTooltip>
      </div>
      <pre
        data-vaul-no-drag=""
        className={cn(
          "select-text overflow-x-auto overscroll-x-contain px-3.5 py-2.5 font-mono text-[13px] leading-[1.55]",
          props.styles.codeBody,
        )}
      >
        <HighlightedCodeBlock
          code={props.code}
          language={resolvedSyntaxLanguage}
          inverted={props.inverted}
        />
      </pre>
    </div>
  );
}

function getAlignClass(align: TableAlign): string {
  switch (align) {
    case "center":
      return "text-center tabular-nums";
    case "right":
      return "text-right tabular-nums";
    case "left":
      return "text-left";
    default:
      return assertNever(align);
  }
}

/**
 * 安全渲染聊天与提案正文中的结构化 Markdown、围栏代码块与对比表格。
 *
 * @param props - 待渲染的 Markdown 文本、色调与可选外层样式类名
 * @returns 结构化排版的 React 视图
 */
export function MarkdownContent(props: MarkdownContentProps) {
  const { t } = useComponentsI18n();
  const blocks = useMemo(() => parseMarkdownBlocks(props.content), [props.content]);
  const styles = getToneStyles(props.tone ?? "default");
  const inlineLabels = useMemo<InlineMarkdownLabels>(
    () => ({
      externalImageWithAlt: (alt: string) => t("markdown.externalImageWithAlt", { alt }),
      externalImageFallback: t("markdown.externalImageFallback"),
    }),
    [t],
  );

  return (
    <div
      className={cn(
        "min-w-0 max-w-full select-text space-y-2 text-[14.5px] leading-[1.58] tracking-[-0.005em] break-words [overflow-wrap:anywhere]",
        styles.rootText,
        props.className,
      )}
    >
      {blocks.map((block) => {
        switch (block.kind) {
          case "code":
            return (
              <CodeFenceBlock
                key={block.id}
                language={block.language}
                code={block.code}
                styles={styles}
                inverted={props.tone === "inverted"}
              />
            );

          case "hr":
            return <hr key={block.id} className={styles.hr} />;

          case "heading": {
            const sizeClass =
              block.level === 1
                ? cn("text-[16.5px] font-semibold tracking-tight", styles.headingStrong)
                : block.level === 2
                  ? cn("text-[15.5px] font-semibold tracking-tight", styles.headingStrong)
                  : cn("text-[15px] font-semibold", styles.headingSoft);
            return (
              <h4 key={block.id} className={cn("pt-0.5", sizeClass)}>
                {renderInlineMarkdown(block.text, block.id, styles, inlineLabels)}
              </h4>
            );
          }

          case "blockquote":
            return (
              <blockquote key={block.id} className={cn("leading-relaxed", styles.blockquote)}>
                {block.lines.map((line, linePos) => (
                  <p key={`${block.id}-q-${String(linePos)}`}>
                    {renderInlineMarkdown(
                      line,
                      `${block.id}-q-${String(linePos)}`,
                      styles,
                      inlineLabels,
                    )}
                  </p>
                ))}
              </blockquote>
            );

          case "ul":
            return (
              <ul key={block.id} className="list-disc space-y-1 pl-5 marker:opacity-55">
                {block.items.map((item, itemPos) => (
                  <li key={`${block.id}-li-${String(itemPos)}`}>
                    {renderInlineMarkdown(
                      item,
                      `${block.id}-li-${String(itemPos)}`,
                      styles,
                      inlineLabels,
                    )}
                  </li>
                ))}
              </ul>
            );

          case "ol":
            return (
              <ol
                key={block.id}
                className="list-decimal space-y-1 pl-5 tabular-nums marker:opacity-65"
              >
                {block.items.map((item, itemPos) => (
                  <li key={`${block.id}-oli-${String(itemPos)}`}>
                    {renderInlineMarkdown(
                      item,
                      `${block.id}-oli-${String(itemPos)}`,
                      styles,
                      inlineLabels,
                    )}
                  </li>
                ))}
              </ol>
            );

          case "table":
            return (
              <div
                key={block.id}
                data-vaul-no-drag=""
                className={cn(
                  "my-2 max-w-full overflow-x-auto overscroll-x-contain rounded-xl",
                  styles.tableWrap,
                )}
              >
                <table
                  className={cn("min-w-full divide-y text-left text-[13.5px]", styles.tableDivide)}
                >
                  <thead className={cn("text-[12px] font-semibold", styles.thead)}>
                    <tr>
                      {block.headers.map((header, colIdx) => (
                        <th
                          key={`${block.id}-th-${String(colIdx)}`}
                          className={cn(
                            "whitespace-nowrap px-3 py-2",
                            getAlignClass(block.alignments[colIdx] ?? "left"),
                          )}
                        >
                          {renderInlineMarkdown(
                            header,
                            `${block.id}-th-${String(colIdx)}`,
                            styles,
                            inlineLabels,
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className={cn("divide-y", styles.tableDivide, styles.tbody)}>
                    {block.rows.map((row, rowIdx) => (
                      <tr
                        key={`${block.id}-tr-${String(rowIdx)}`}
                        className={cn("transition-colors", styles.rowHover)}
                      >
                        {block.headers.map((_h, colIdx) => {
                          const cell = row[colIdx] ?? "";
                          return (
                            <td
                              key={`${block.id}-td-${String(rowIdx)}-${String(colIdx)}`}
                              className={cn(
                                "px-3 py-2 align-top",
                                styles.td,
                                getAlignClass(block.alignments[colIdx] ?? "left"),
                              )}
                            >
                              {renderInlineMarkdown(
                                cell,
                                `${block.id}-td-${String(rowIdx)}-${String(colIdx)}`,
                                styles,
                                inlineLabels,
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );

          case "paragraph":
            return (
              <p key={block.id} className="whitespace-pre-wrap">
                {block.lines.map((line, lineIdx) => (
                  <span key={`${block.id}-ln-${String(lineIdx)}`}>
                    {lineIdx > 0 ? "\n" : null}
                    {renderInlineMarkdown(
                      line,
                      `${block.id}-ln-${String(lineIdx)}`,
                      styles,
                      inlineLabels,
                    )}
                  </span>
                ))}
              </p>
            );

          default:
            return assertNever(block);
        }
      })}
    </div>
  );
}
