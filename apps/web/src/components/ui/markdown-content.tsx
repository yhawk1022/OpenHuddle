/**
 * @module web/components/ui/markdown-content
 * @description 零 XSS 纯 React AST 消息 Markdown 与多方案对比表格渲染引擎（严禁使用 `dangerouslySetInnerHTML`），遵循 Pachat 自然纸感排版规范。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 绝对零 XSS 攻击面：所有跨主理人 / 跨 Agent 群聊消息均视为不可信外部输入（Untrusted Input），仅构造受控 React 节点，外部超链接强制通过 `http:` / `https:` 协议白名单校验。
 * 2. Pachat 自然阅读韵律：正文统一采用 `15px`（`text-[15px] leading-[1.48]`）舒展字号；`@提及` 使用克制的鼠尾草深绿（`#2A7B59` / 暗夜 `#5ED3A2`）字重强调；围栏代码块采用低调纸面灰底（`bg-black/[0.04] dark:bg-white/[0.06]`）取代沉重花哨的彩色终端框。
 * 3. 向后兼容 `tone` 契约：无论本人象牙暖白气泡（`#F6F2EC` / `#272521`）还是对端气泡，默认 `tone="default"` 均保持天然墨色对比；保留 `inverted` 分支供深底特殊容器兼容调用。
 */
import { assertNever } from "@openhuddle/protocol";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { AppTooltip, IconButton, cn, toast } from "../primitives/index.js";

/** Markdown 渲染色调：`default` = Pachat 标准纸感气泡与面板；`inverted` = 深底反白兼容色调 */
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

    // 1. 围栏代码块 ```lang
    if (trimmed.startsWith("```")) {
      const startLine = cursor;
      const language = trimmed.slice(3).trim() || "code";
      cursor += 1;
      const codeLines: string[] = [];
      while (cursor < lines.length) {
        const current = lines[cursor] ?? "";
        if (current.trim().startsWith("```")) {
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
    "rounded-[5px] bg-black/[0.045] px-1.5 py-[1px] font-mono text-[0.86em] text-[#141414] ring-1 ring-inset ring-black/[0.06] dark:bg-white/[0.07] dark:text-zinc-100 dark:ring-white/[0.08]",
  strong: "font-semibold text-[#141414] dark:text-white",
  em: "italic opacity-90",
  link: "font-medium text-[#2F6FED] underline decoration-[#2F6FED]/35 underline-offset-[3px] transition-colors hover:decoration-[#2F6FED] dark:text-[#6EA3FF] dark:decoration-[#6EA3FF]/40",
  mention: "font-medium text-[#2A7B59] dark:text-[#5ED3A2]",
  hr: "my-2.5 border-t border-black/[0.08] dark:border-white/[0.08]",
  headingStrong: "text-[#141414] dark:text-white",
  headingSoft: "text-[#141414] dark:text-zinc-100",
  blockquote:
    "border-l-2 border-black/20 pl-3 py-0.5 text-[14px] text-[#5F5F64] dark:border-white/25 dark:text-zinc-400",
  tableWrap: "bg-black/[0.02] ring-1 ring-black/[0.07] dark:bg-white/[0.03] dark:ring-white/[0.08]",
  tableDivide: "divide-black/[0.07] dark:divide-white/[0.08]",
  thead: "bg-black/[0.035] text-[#141414] dark:bg-white/[0.05] dark:text-zinc-100",
  tbody: "bg-transparent",
  rowHover: "hover:bg-black/[0.025] dark:hover:bg-white/[0.03]",
  td: "text-[#3A3A3C] dark:text-zinc-200",
  codeFence:
    "bg-black/[0.04] ring-1 ring-inset ring-black/[0.06] dark:bg-white/[0.06] dark:ring-white/[0.08]",
  codeHeader:
    "border-b border-black/[0.06] text-[#6E6E73] dark:border-white/[0.07] dark:text-zinc-400",
  codeBody: "text-[#141414] dark:text-zinc-100",
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
  /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\)|@[A-Za-z0-9_\-\u4e00-\u9fa5]+)/g;

function renderInlineMarkdown(
  text: string,
  keyPrefix: string,
  styles: MarkdownToneStyles,
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
          {matchText.slice(2, -2)}
        </strong>,
      );
    } else if (matchText.startsWith("*") && matchText.endsWith("*") && matchText.length >= 2) {
      nodes.push(
        <em key={tokenKey} className={styles.em}>
          {matchText.slice(1, -1)}
        </em>,
      );
    } else if (matchText.startsWith("[")) {
      const linkParts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(matchText);
      const label = linkParts?.[1];
      const rawHref = linkParts?.[2];
      const safeHref = rawHref !== undefined ? sanitizeSafeHttpUrl(rawHref.trim()) : null;
      if (label !== undefined && safeHref !== null) {
        nodes.push(
          <a
            key={tokenKey}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
          >
            {label}
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
}

function CodeFenceBlock(props: CodeFenceBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(props.code).then(() => {
      setCopied(true);
      toast.success("代码已复制");
      window.setTimeout(() => {
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
          {props.language}
        </span>

        <AppTooltip content={copied ? "已复制" : "复制代码"} side="top">
          <IconButton
            size="xs"
            variant="ghost"
            label="复制代码"
            onClick={handleCopy}
            className="h-6 w-6 text-[#6E6E73] hover:bg-black/[0.05] hover:text-[#141414] dark:text-zinc-400 dark:hover:bg-white/[0.08] dark:hover:text-zinc-100"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-[#34C759]" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </IconButton>
        </AppTooltip>
      </div>
      <pre
        className={cn(
          "select-text overflow-x-auto px-3.5 py-2.5 font-mono text-[13px] leading-[1.55]",
          props.styles.codeBody,
        )}
      >
        <code>{props.code}</code>
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
 * 零 XSS 安全渲染聊天正文中的结构化 Markdown、克制纸面代码块与多方案对比表格。
 *
 * @remarks
 * 正文容器采用 Pachat 标准 `text-[15px] leading-[1.48]` 舒展阅读规格并显式声明 `select-text`，
 * 确保在桌面与移动端原生外壳下用户随时可划选复制。
 *
 * @param props - 待渲染的 Markdown 文本、色调与可选外层样式类名
 * @returns 结构化排版的 React 视图
 */
export function MarkdownContent(props: MarkdownContentProps) {
  const blocks = parseMarkdownBlocks(props.content);
  const styles = getToneStyles(props.tone ?? "default");

  return (
    <div
      className={cn(
        "select-text space-y-2 text-[15px] leading-[1.48] tracking-[-0.005em] break-words [overflow-wrap:anywhere]",
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
                {renderInlineMarkdown(block.text, block.id, styles)}
              </h4>
            );
          }

          case "blockquote":
            return (
              <blockquote key={block.id} className={cn("leading-relaxed", styles.blockquote)}>
                {block.lines.map((line, linePos) => (
                  <p key={`${block.id}-q-${String(linePos)}`}>
                    {renderInlineMarkdown(line, `${block.id}-q-${String(linePos)}`, styles)}
                  </p>
                ))}
              </blockquote>
            );

          case "ul":
            return (
              <ul key={block.id} className="list-disc space-y-1 pl-5 marker:opacity-55">
                {block.items.map((item, itemPos) => (
                  <li key={`${block.id}-li-${String(itemPos)}`}>
                    {renderInlineMarkdown(item, `${block.id}-li-${String(itemPos)}`, styles)}
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
                    {renderInlineMarkdown(item, `${block.id}-oli-${String(itemPos)}`, styles)}
                  </li>
                ))}
              </ol>
            );

          case "table":
            return (
              <div
                key={block.id}
                className={cn("my-2 max-w-full overflow-x-auto rounded-xl", styles.tableWrap)}
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
                          {renderInlineMarkdown(header, `${block.id}-th-${String(colIdx)}`, styles)}
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
                    {renderInlineMarkdown(line, `${block.id}-ln-${String(lineIdx)}`, styles)}
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
