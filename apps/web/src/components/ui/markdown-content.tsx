/**
 * @module web/components/ui/markdown-content
 * @description 零 XSS 纯 React AST 消息 Markdown 与对比表格渲染引擎（绝不使用 `dangerouslySetInnerHTML`）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 绝对零 XSS 攻击面：所有跨主人/跨 Agent 群聊消息均视为不可信外部输入（Untrusted Input），仅构造受控 React 元素，严禁注入原始 HTML；超链接强制校验 `http:` / `https:` 协议白名单。
 * 2. 面向研发讨论深度优化：原生解析多模型辩论高频使用的围栏代码块（附一键复制按钮）、GFM `| --- |` 对比表格、多级标题、引用块、列表及 `@mention` 胶囊高亮。
 */
import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";

/** `MarkdownContent` 组件入参属性 */
export interface MarkdownContentProps {
  readonly content: string;
  readonly className?: string | undefined;
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
      const language = trimmed.slice(3).trim() || "text";
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

const INLINE_TOKEN_REGEX =
  /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\)|@[A-Za-z0-9_\-\u4e00-\u9fa5]+)/g;

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
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
        <code
          key={tokenKey}
          className="rounded-md border border-slate-200/80 bg-slate-100 px-1.5 py-0.5 font-mono text-[0.82em] text-indigo-700 dark:border-white/10 dark:bg-white/[0.07] dark:text-indigo-300"
        >
          {matchText.slice(1, -1)}
        </code>,
      );
    } else if (matchText.startsWith("**") && matchText.endsWith("**") && matchText.length >= 4) {
      nodes.push(
        <strong key={tokenKey} className="font-semibold text-slate-900 dark:text-white">
          {matchText.slice(2, -2)}
        </strong>,
      );
    } else if (matchText.startsWith("*") && matchText.endsWith("*") && matchText.length >= 2) {
      nodes.push(
        <em key={tokenKey} className="italic text-slate-700 dark:text-slate-200">
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
            className="font-medium text-indigo-600 underline decoration-indigo-500/40 underline-offset-2 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            {label}
          </a>,
        );
      } else {
        nodes.push(matchText);
      }
    } else if (matchText.startsWith("@")) {
      nodes.push(
        <span
          key={tokenKey}
          className="inline-flex items-center rounded-md bg-indigo-500/12 px-1.5 py-0.2 font-medium text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300"
        >
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
}

function CodeFenceBlock(props: CodeFenceBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(props.code).then(() => {
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 1_800);
    });
  };

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-slate-200 bg-slate-950 text-slate-100 shadow-xs dark:border-white/10 dark:bg-[#07090e]">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] text-slate-400">
        <span className="font-mono uppercase tracking-wider">{props.language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-400" />
              <span className="text-emerald-300">已复制</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>复制代码</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 font-mono text-[12.5px] leading-relaxed text-slate-100">
        <code>{props.code}</code>
      </pre>
    </div>
  );
}

/**
 * 零 XSS 安全渲染聊天正文中的结构化 Markdown、围栏代码块与多方案对比表格。
 *
 * @param props - 待渲染的 Markdown 文本与可选外层样式类名
 * @returns 结构化排版的 React 视图
 */
export function MarkdownContent(props: MarkdownContentProps) {
  const blocks = parseMarkdownBlocks(props.content);

  return (
    <div className={`space-y-2.5 text-[14px] leading-relaxed break-words ${props.className ?? ""}`}>
      {blocks.map((block) => {
        switch (block.kind) {
          case "code":
            return <CodeFenceBlock key={block.id} language={block.language} code={block.code} />;

          case "hr":
            return (
              <hr
                key={block.id}
                className="my-3 border-t border-slate-200/80 dark:border-white/10"
              />
            );

          case "heading": {
            const sizeClass =
              block.level === 1
                ? "text-base font-bold text-slate-900 dark:text-white"
                : block.level === 2
                  ? "text-[15px] font-semibold text-slate-900 dark:text-white"
                  : "text-sm font-semibold text-slate-800 dark:text-slate-100";
            return (
              <h4 key={block.id} className={`pt-1 ${sizeClass}`}>
                {renderInlineMarkdown(block.text, block.id)}
              </h4>
            );
          }

          case "blockquote":
            return (
              <blockquote
                key={block.id}
                className="rounded-r-lg border-l-3 border-indigo-500/60 bg-slate-100/80 py-1.5 pl-3 pr-2.5 text-[13.5px] text-slate-700 dark:bg-white/[0.04] dark:text-slate-300"
              >
                {block.lines.map((line, linePos) => (
                  <p key={`${block.id}-q-${String(linePos)}`}>
                    {renderInlineMarkdown(line, `${block.id}-q-${String(linePos)}`)}
                  </p>
                ))}
              </blockquote>
            );

          case "ul":
            return (
              <ul key={block.id} className="list-disc space-y-1 pl-5">
                {block.items.map((item, itemPos) => (
                  <li key={`${block.id}-li-${String(itemPos)}`}>
                    {renderInlineMarkdown(item, `${block.id}-li-${String(itemPos)}`)}
                  </li>
                ))}
              </ul>
            );

          case "ol":
            return (
              <ol key={block.id} className="list-decimal space-y-1 pl-5">
                {block.items.map((item, itemPos) => (
                  <li key={`${block.id}-oli-${String(itemPos)}`}>
                    {renderInlineMarkdown(item, `${block.id}-oli-${String(itemPos)}`)}
                  </li>
                ))}
              </ol>
            );

          case "table":
            return (
              <div
                key={block.id}
                className="my-2 overflow-x-auto rounded-xl border border-slate-200/90 dark:border-white/10"
              >
                <table className="min-w-full divide-y divide-slate-200 text-left text-[13px] dark:divide-white/10">
                  <thead className="bg-slate-100/90 text-xs font-semibold text-slate-700 dark:bg-white/[0.04] dark:text-slate-200">
                    <tr>
                      {block.headers.map((header, colIdx) => {
                        const align = block.alignments[colIdx] ?? "left";
                        const alignClass =
                          align === "center"
                            ? "text-center"
                            : align === "right"
                              ? "text-right"
                              : "text-left";
                        return (
                          <th
                            key={`${block.id}-th-${String(colIdx)}`}
                            className={`px-3 py-2 ${alignClass}`}
                          >
                            {renderInlineMarkdown(header, `${block.id}-th-${String(colIdx)}`)}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/70 bg-white/70 dark:divide-white/[0.06] dark:bg-transparent">
                    {block.rows.map((row, rowIdx) => (
                      <tr
                        key={`${block.id}-tr-${String(rowIdx)}`}
                        className="transition-colors hover:bg-slate-50/80 dark:hover:bg-white/[0.02]"
                      >
                        {block.headers.map((_h, colIdx) => {
                          const cell = row[colIdx] ?? "";
                          const align = block.alignments[colIdx] ?? "left";
                          const alignClass =
                            align === "center"
                              ? "text-center"
                              : align === "right"
                                ? "text-right"
                                : "text-left";
                          return (
                            <td
                              key={`${block.id}-td-${String(rowIdx)}-${String(colIdx)}`}
                              className={`px-3 py-2 text-slate-700 dark:text-slate-300 ${alignClass}`}
                            >
                              {renderInlineMarkdown(
                                cell,
                                `${block.id}-td-${String(rowIdx)}-${String(colIdx)}`,
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
                    {renderInlineMarkdown(line, `${block.id}-ln-${String(lineIdx)}`)}
                  </span>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
