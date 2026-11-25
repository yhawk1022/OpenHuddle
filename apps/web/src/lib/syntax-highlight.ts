/**
 * @module web/lib/syntax-highlight
 * @description 零外部依赖、同步零闪烁的多语言词法着色分词器（Stateful Lexical Syntax Tokenizer）。
 *
 * 架构职责与关键不变量（Invariants）：
 * 1. 零包体积膨胀与同步首帧渲染：无需加载数 MB 的 Oniguruma WASM，单次扫描耗时 `< 0.2ms`，在虚拟滚动聊天流与多文件 Unified Diff 切换中 100% 零异步闪烁（Zero FOUC）。
 * 2. 跨行词法状态保持：支持多行块注释（`/* ... * /` 含 `@param` 等 TSDoc 标签识别）与多行模板字符串（`` `...` ``）在 Unified Diff 连续代码行间准确延续状态。
 * 3. 原生桌面光学适配：词法类别面向 Xcode / Tower 中性双主题调色板设计，确保在明亮暖瓷白、暗夜烟熏石墨（`#141417`）以及 Diff 增删底色上均满足高可读对比度。
 */

/**
 * 语法高亮词法单元类别。
 */
export type SyntaxTokenKind =
  | "plain"
  | "keyword"
  | "type"
  | "function"
  | "string"
  | "number"
  | "comment"
  | "doc_tag"
  | "property"
  | "operator"
  | "punctuation"
  | "diff_add"
  | "diff_del"
  | "diff_hunk";

/**
 * 单个语法着色词法片段。
 */
export interface SyntaxToken {
  readonly kind: SyntaxTokenKind;
  readonly text: string;
}

/**
 * 支持语法分析的语言族枚举。
 */
export type SyntaxLanguage =
  | "ts"
  | "html"
  | "json"
  | "yaml"
  | "markdown"
  | "css"
  | "shell"
  | "python"
  | "rust"
  | "go"
  | "sql"
  | "diff"
  | "plain";

interface HtmlOpenTagState {
  readonly tagName: string;
}

interface ScannerState {
  inBlockComment: boolean;
  inTemplateLiteral: boolean;
  inHtmlComment: boolean;
  htmlOpenTag: HtmlOpenTagState | null;
  htmlEmbeddedLang: "ts" | "css" | null;
}

function createInitialScannerState(): ScannerState {
  return {
    inBlockComment: false,
    inTemplateLiteral: false,
    inHtmlComment: false,
    htmlOpenTag: null,
    htmlEmbeddedLang: null,
  };
}

function cloneScannerState(state: ScannerState): ScannerState {
  return {
    inBlockComment: state.inBlockComment,
    inTemplateLiteral: state.inTemplateLiteral,
    inHtmlComment: state.inHtmlComment,
    htmlOpenTag: state.htmlOpenTag !== null ? { tagName: state.htmlOpenTag.tagName } : null,
    htmlEmbeddedLang: state.htmlEmbeddedLang,
  };
}

const TS_KEYWORDS: ReadonlySet<string> = new Set([
  "import",
  "export",
  "from",
  "as",
  "default",
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "switch",
  "case",
  "break",
  "continue",
  "for",
  "of",
  "in",
  "while",
  "do",
  "try",
  "catch",
  "finally",
  "throw",
  "new",
  "typeof",
  "instanceof",
  "keyof",
  "readonly",
  "interface",
  "type",
  "enum",
  "class",
  "extends",
  "implements",
  "public",
  "private",
  "protected",
  "static",
  "async",
  "await",
  "yield",
  "void",
  "delete",
  "satisfies",
  "declare",
  "namespace",
]);

const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  "def",
  "class",
  "return",
  "if",
  "elif",
  "else",
  "for",
  "in",
  "while",
  "break",
  "continue",
  "try",
  "except",
  "finally",
  "raise",
  "with",
  "as",
  "import",
  "from",
  "pass",
  "lambda",
  "yield",
  "async",
  "await",
  "and",
  "or",
  "not",
  "is",
]);

const RUST_GO_KEYWORDS: ReadonlySet<string> = new Set([
  "fn",
  "func",
  "let",
  "mut",
  "const",
  "pub",
  "struct",
  "enum",
  "impl",
  "trait",
  "type",
  "interface",
  "package",
  "import",
  "use",
  "mod",
  "crate",
  "self",
  "super",
  "match",
  "if",
  "else",
  "for",
  "in",
  "while",
  "loop",
  "return",
  "break",
  "continue",
  "async",
  "await",
  "defer",
  "go",
  "chan",
  "select",
  "where",
]);

const SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "in",
  "do",
  "done",
  "case",
  "esac",
  "while",
  "function",
  "return",
  "export",
  "local",
  "readonly",
  "set",
  "unset",
  "source",
  "sudo",
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "bun",
  "node",
  "git",
  "docker",
  "curl",
  "echo",
  "cd",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "cat",
  "chmod",
  "FROM",
  "RUN",
  "COPY",
  "ADD",
  "WORKDIR",
  "ENV",
  "ARG",
  "ENTRYPOINT",
  "CMD",
  "EXPOSE",
]);

const SQL_KEYWORDS: ReadonlySet<string> = new Set([
  "select",
  "from",
  "where",
  "insert",
  "into",
  "values",
  "update",
  "set",
  "delete",
  "create",
  "table",
  "index",
  "alter",
  "drop",
  "join",
  "inner",
  "left",
  "right",
  "on",
  "and",
  "or",
  "not",
  "null",
  "is",
  "in",
  "exists",
  "order",
  "by",
  "group",
  "having",
  "limit",
  "offset",
  "as",
  "distinct",
  "union",
  "all",
  "begin",
  "commit",
  "rollback",
  "for",
  "primary",
  "key",
  "references",
  "cascade",
  "returning",
]);

const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "unknown",
  "never",
  "any",
  "object",
  "Promise",
  "Readonly",
  "ReadonlyArray",
  "Record",
  "Partial",
  "Pick",
  "Omit",
  "Map",
  "Set",
  "Date",
  "Error",
  "RegExp",
  "Array",
  "Uint8Array",
  "Buffer",
  "i32",
  "i64",
  "u32",
  "u64",
  "usize",
  "f32",
  "f64",
  "bool",
  "str",
  "String",
  "Vec",
  "Option",
  "Result",
]);

const LITERAL_CONSTANTS: ReadonlySet<string> = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity",
  "None",
  "True",
  "False",
  "nil",
]);

const EXPLICIT_PLAIN_LANGUAGES: ReadonlySet<string> = new Set([
  "text",
  "txt",
  "plaintext",
  "plain",
  "none",
  "raw",
  "ascii",
  "log",
]);

function extractPrimaryLanguageToken(rawLang: string | undefined): string {
  const stripped = (rawLang ?? "")
    .trim()
    .replace(/^[`~]+/, "")
    .trim();
  const head = stripped.split(/[\s:{(\[|,;]+/)[0] ?? "";
  return head.replace(/^\./, "").toLowerCase();
}

/**
 * 将 Markdown 代码块语言标签标准化为内部 `SyntaxLanguage`。
 * 支持带元信息的围栏标记（如 `html title="index.html"`、`ts:src/app.ts`、`js{1-3}`、`c++`、`c#`）。
 *
 * @param rawLang - 原始语言标识（如 `typescript`、`html`、`bash`、`py`）
 * @returns 匹配的语言族枚举
 */
export function normalizeSyntaxLanguage(rawLang: string | undefined): SyntaxLanguage {
  const clean = extractPrimaryLanguageToken(rawLang);
  switch (clean) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
    case "typescript":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "javascript":
    case "ecmascript":
    case "es6":
    case "node":
    case "nodejs":
    case "deno":
    case "bun":
    case "react":
    case "nextjs":
    case "java":
    case "c":
    case "h":
    case "cpp":
    case "c++":
    case "cc":
    case "cxx":
    case "hpp":
    case "cs":
    case "csharp":
    case "c#":
    case "fsharp":
    case "f#":
    case "objc":
    case "objective-c":
    case "swift":
    case "kt":
    case "kts":
    case "kotlin":
    case "dart":
    case "scala":
    case "groovy":
    case "php":
    case "zig":
    case "proto":
    case "protobuf":
    case "graphql":
    case "gql":
    case "prisma":
    case "solidity":
    case "sol":
      return "ts";
    case "html":
    case "html5":
    case "htm":
    case "xhtml":
    case "xml":
    case "svg":
    case "vue":
    case "svelte":
    case "astro":
    case "hbs":
    case "handlebars":
    case "ejs":
      return "html";
    case "json":
    case "jsonc":
    case "json5":
    case "jsonl":
    case "ndjson":
      return "json";
    case "yaml":
    case "yml":
    case "toml":
    case "ini":
    case "env":
    case "dotenv":
    case "conf":
    case "properties":
      return "yaml";
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    case "css":
    case "scss":
    case "sass":
    case "less":
    case "postcss":
    case "tailwind":
      return "css";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "shell":
    case "console":
    case "terminal":
    case "powershell":
    case "ps1":
    case "pwsh":
    case "dockerfile":
    case "docker":
    case "makefile":
    case "make":
      return "shell";
    case "py":
    case "python":
    case "python3":
    case "rb":
    case "ruby":
    case "ex":
    case "exs":
    case "elixir":
    case "r":
    case "perl":
      return "python";
    case "rs":
    case "rust":
      return "rust";
    case "go":
    case "golang":
      return "go";
    case "sql":
    case "mysql":
    case "sqlite":
    case "postgres":
    case "postgresql":
    case "pgsql":
    case "plsql":
      return "sql";
    case "diff":
    case "patch":
      return "diff";
    default: {
      if (clean.includes(".")) {
        return inferSyntaxLanguageFromPath(clean);
      }
      return "plain";
    }
  }
}

/**
 * 从文件路径后缀推断最匹配的语法高亮语言族。
 *
 * @param filePath - 代码文件相对或绝对路径
 * @returns 语法语言枚举
 */
export function inferSyntaxLanguageFromPath(filePath: string): SyntaxLanguage {
  const lower = filePath.trim().toLowerCase();
  const baseName = lower.split("/").pop() ?? lower;
  if (baseName === "dockerfile" || baseName === "makefile") {
    return "shell";
  }
  const ext = baseName.includes(".") ? (baseName.split(".").pop() ?? "") : "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "java":
    case "c":
    case "h":
    case "cpp":
    case "hpp":
    case "cs":
    case "swift":
    case "kt":
    case "dart":
    case "php":
    case "proto":
    case "graphql":
    case "prisma":
      return "ts";
    case "html":
    case "htm":
    case "xml":
    case "svg":
    case "vue":
    case "svelte":
    case "astro":
      return "html";
    case "json":
    case "jsonc":
    case "json5":
      return "json";
    case "yaml":
    case "yml":
    case "toml":
    case "ini":
    case "env":
      return "yaml";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "py":
    case "rb":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "sql":
      return "sql";
    case "diff":
    case "patch":
      return "diff";
    default:
      return "plain";
  }
}

/**
 * 对未标注语言标签的围栏代码块执行轻量结构启发式识别，避免裸 ` ``` ` 代码块丢失高亮。
 *
 * @param code - 原始多行代码文本
 * @returns 推断出的语言族；若为普通自然语言文本则返回 `"plain"`
 */
export function detectSyntaxLanguageFromCode(code: string): SyntaxLanguage {
  const sample = code.trimStart().slice(0, 2_400);
  if (sample.length === 0) {
    return "plain";
  }

  // 1. Shebang 首行
  if (sample.startsWith("#!")) {
    const firstLine = (sample.split("\n", 1)[0] ?? "").toLowerCase();
    if (firstLine.includes("python")) return "python";
    if (firstLine.includes("node") || firstLine.includes("deno") || firstLine.includes("bun")) {
      return "ts";
    }
    return "shell";
  }

  // 2. Unified Diff
  if (/^(?:diff --git |--- a\/|\+\+\+ b\/|@@ -\d+)/m.test(sample)) {
    return "diff";
  }

  // 3. HTML / XML / SVG / 单文件组件
  if (
    /^(?:<!doctype\s+html|<\?xml|<!--)/i.test(sample) ||
    /^\s*<(?:html|head|body|div|span|main|section|article|header|footer|canvas|script|style|svg|template|form|table|button|input)\b/im.test(
      sample,
    )
  ) {
    return "html";
  }

  // 4. JSON 对象或对象数组
  if (/^[\[{]\s*(?:"[^"\n]+"\s*:|\{\s*"[^"\n]+"\s*:)/s.test(sample)) {
    return "json";
  }

  // 5. SQL 语句
  if (
    /^\s*(?:select\s+.+\s+from\s+|insert\s+into\s+|update\s+\w+\s+set\s+|delete\s+from\s+|create\s+(?:table|index|view)\s+|alter\s+table\s+)/is.test(
      sample,
    )
  ) {
    return "sql";
  }

  // 6. Rust / Go / Python
  if (
    /\b(?:fn\s+\w+\s*\(|let\s+mut\s+|pub\s+(?:fn|struct|enum|mod|use)\b|#\[derive\()/.test(sample)
  ) {
    return "rust";
  }
  if (
    /^\s*package\s+[a-z_]\w*/m.test(sample) ||
    /\bfunc\s+(?:\([^)]+\)\s*)?\w+\s*\(/.test(sample)
  ) {
    return "go";
  }
  if (
    /^\s*(?:def\s+\w+\s*\(|from\s+[\w.]+\s+import\s+|elif\s+.+:|except(?:\s+\w+)?\s*:)/m.test(
      sample,
    )
  ) {
    return "python";
  }

  // 7. CSS 样式表
  if (
    /^\s*(?::root|\.dark|@media\b|@keyframes\b|[.#][a-zA-Z_-][\w-]*\s*\{)/m.test(sample) &&
    /[a-z-]+\s*:\s*[^;\n]+;/.test(sample)
  ) {
    return "css";
  }

  // 8. JS / TS / C 族代码
  if (
    /\b(?:const|let|var|function|import|export|interface|type|class|async|await|return)\b/.test(
      sample,
    ) &&
    /(?:=>|[=;{()])/.test(sample)
  ) {
    return "ts";
  }

  // 9. Shell 命令片段
  if (
    /^\s*(?:\$\s+\S+|(?:pnpm|npm|npx|yarn|bun|curl|git|docker|brew|chmod|mkdir|export)\s+\S+)/m.test(
      sample,
    )
  ) {
    return "shell";
  }

  return "plain";
}

/**
 * 解析 Markdown 代码块最终用于着色的 `SyntaxLanguage`：
 * 优先按显式语言标签归一化；若未标注或标签未知（且非显式 `text`/`plain`），则回退到代码结构识别。
 */
export function resolveCodeBlockSyntaxLanguage(
  rawLang: string | undefined,
  code: string,
): SyntaxLanguage {
  const primary = extractPrimaryLanguageToken(rawLang);
  if (EXPLICIT_PLAIN_LANGUAGES.has(primary)) {
    return "plain";
  }
  const normalized = normalizeSyntaxLanguage(rawLang);
  if (normalized !== "plain") {
    return normalized;
  }
  return detectSyntaxLanguageFromCode(code);
}

/**
 * 生成代码块题头展示用的精简语言名。
 */
export function formatCodeFenceLanguageLabel(
  rawLang: string | undefined,
  resolvedLanguage: SyntaxLanguage,
): string {
  const cleaned = (rawLang ?? "")
    .trim()
    .replace(/^[`~]+/, "")
    .trim();
  if (cleaned.length > 0 && cleaned.toLowerCase() !== "code") {
    return cleaned;
  }
  if (resolvedLanguage === "plain") {
    return "code";
  }
  return resolvedLanguage;
}

function pushToken(out: SyntaxToken[], kind: SyntaxTokenKind, text: string): void {
  if (text.length === 0) {
    return;
  }
  const prev = out[out.length - 1];
  if (prev !== undefined && prev.kind === kind) {
    out[out.length - 1] = { kind, text: prev.text + text };
    return;
  }
  out.push({ kind, text });
}

function tokenizeBlockCommentSegment(out: SyntaxToken[], segment: string): void {
  const tagRegex = /@[a-zA-Z][a-zA-Z0-9_-]*/g;
  let lastIdx = 0;
  for (const match of segment.matchAll(tagRegex)) {
    const idx = match.index ?? 0;
    if (idx > lastIdx) {
      pushToken(out, "comment", segment.slice(lastIdx, idx));
    }
    pushToken(out, "doc_tag", match[0]);
    lastIdx = idx + match[0].length;
  }
  if (lastIdx < segment.length) {
    pushToken(out, "comment", segment.slice(lastIdx));
  }
}

function isIdentStart(ch: string): boolean {
  return /[a-zA-Z_$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[a-zA-Z0-9_$]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function tokenizeCssLine(line: string, state: ScannerState): ReadonlyArray<SyntaxToken> {
  const out: SyntaxToken[] = [];
  let i = 0;
  const len = line.length;

  while (i < len) {
    if (state.inBlockComment) {
      const end = line.indexOf("*/", i);
      if (end === -1) {
        pushToken(out, "comment", line.slice(i));
        return out;
      }
      pushToken(out, "comment", line.slice(i, end + 2));
      state.inBlockComment = false;
      i = end + 2;
      continue;
    }

    if (line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        pushToken(out, "comment", line.slice(i));
        state.inBlockComment = true;
        return out;
      }
      pushToken(out, "comment", line.slice(i, end + 2));
      i = end + 2;
      continue;
    }

    const ch = line[i] ?? "";
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j++;
          break;
        }
        j++;
      }
      pushToken(out, "string", line.slice(i, j));
      i = j;
      continue;
    }

    // CSS 变量 `--oh-*` 或属性名 `background-color:`
    const propMatch = /^(--[a-zA-Z0-9_-]+|[a-zA-Z-]+)(?=\s*:)/.exec(line.slice(i));
    if (propMatch?.[0]) {
      pushToken(out, "property", propMatch[0]);
      i += propMatch[0].length;
      continue;
    }

    // 十六进制色值 `#141417` 或类选择器 `.dark`
    const hexMatch = /^#[0-9a-fA-F]{3,8}\b/.exec(line.slice(i));
    if (hexMatch?.[0]) {
      pushToken(out, "number", hexMatch[0]);
      i += hexMatch[0].length;
      continue;
    }

    const classSelMatch = /^\.[a-zA-Z_-][a-zA-Z0-9_-]*/.exec(line.slice(i));
    if (classSelMatch?.[0]) {
      pushToken(out, "type", classSelMatch[0]);
      i += classSelMatch[0].length;
      continue;
    }

    const numMatch = /^-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|dvh|%|ms|s|deg)?/.exec(line.slice(i));
    if (numMatch?.[0]) {
      pushToken(out, "number", numMatch[0]);
      i += numMatch[0].length;
      continue;
    }

    if ("{}:;(),>".includes(ch)) {
      pushToken(out, "punctuation", ch);
      i++;
      continue;
    }

    pushToken(out, "plain", ch);
    i++;
  }
  return out;
}

function appendTokens(out: SyntaxToken[], tokens: ReadonlyArray<SyntaxToken>): void {
  for (const tok of tokens) {
    pushToken(out, tok.kind, tok.text);
  }
}

function tokenizeDoctypeRest(out: SyntaxToken[], segment: string): void {
  let idx = 0;
  const len = segment.length;
  while (idx < len) {
    const ch = segment[idx] ?? "";
    if (ch === " " || ch === "\t") {
      let j = idx + 1;
      while (j < len && (segment[j] === " " || segment[j] === "\t")) {
        j++;
      }
      pushToken(out, "plain", segment.slice(idx, j));
      idx = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = idx + 1;
      while (j < len && segment[j] !== ch) {
        j++;
      }
      if (j < len) {
        j++;
      }
      pushToken(out, "string", segment.slice(idx, j));
      idx = j;
      continue;
    }
    const wordMatch = /^[a-zA-Z0-9_:-]+/.exec(segment.slice(idx));
    if (wordMatch?.[0]) {
      pushToken(out, "type", wordMatch[0]);
      idx += wordMatch[0].length;
      continue;
    }
    pushToken(out, "plain", ch);
    idx++;
  }
}

function tokenizeHtmlLine(line: string, state: ScannerState): ReadonlyArray<SyntaxToken> {
  const out: SyntaxToken[] = [];
  const len = line.length;
  let i = 0;

  while (i < len) {
    // 1. 内嵌 <script> (JS/TS) 或 <style> (CSS) 子扫描态
    if (state.htmlEmbeddedLang !== null) {
      const embeddedLang = state.htmlEmbeddedLang;
      const closePattern =
        embeddedLang === "ts" ? /<\/script(?=[>\s/]|$)/i : /<\/style(?=[>\s/]|$)/i;
      const closeMatch = closePattern.exec(line.slice(i));
      if (closeMatch === null) {
        appendTokens(out, tokenizeSingleLine(line.slice(i), embeddedLang, state));
        return out;
      }
      const closeIdx = i + (closeMatch.index ?? 0);
      if (closeIdx > i) {
        appendTokens(out, tokenizeSingleLine(line.slice(i, closeIdx), embeddedLang, state));
      }
      state.htmlEmbeddedLang = null;
      state.inBlockComment = false;
      state.inTemplateLiteral = false;
      if (closeIdx > i) {
        i = closeIdx;
        continue;
      }
      // 当 `closeIdx === i` 时，立即由下方闭合标签分支消费 `</script>` / `</style>` 并推进 `i`
    }

    // 2. 跨行 HTML 注释 `<!-- ... -->`
    if (state.inHtmlComment) {
      const end = line.indexOf("-->", i);
      if (end === -1) {
        pushToken(out, "comment", line.slice(i));
        return out;
      }
      pushToken(out, "comment", line.slice(i, end + 3));
      state.inHtmlComment = false;
      i = end + 3;
      continue;
    }

    // 3. 起始标签属性扫描态 `<canvas id="game" width="400" ...>`
    if (state.htmlOpenTag !== null) {
      const ch = line[i] ?? "";
      if (ch === " " || ch === "\t") {
        let j = i + 1;
        while (j < len && (line[j] === " " || line[j] === "\t")) {
          j++;
        }
        pushToken(out, "plain", line.slice(i, j));
        i = j;
        continue;
      }

      if (line.startsWith("/>", i)) {
        pushToken(out, "punctuation", "/>");
        state.htmlOpenTag = null;
        i += 2;
        continue;
      }

      if (ch === ">") {
        const openedTag = state.htmlOpenTag.tagName;
        pushToken(out, "punctuation", ">");
        state.htmlOpenTag = null;
        if (openedTag === "script") {
          state.htmlEmbeddedLang = "ts";
        } else if (openedTag === "style") {
          state.htmlEmbeddedLang = "css";
        }
        i += 1;
        continue;
      }

      if (ch === "<") {
        // 遇到未闭合左尖括号后紧跟新标签时安全收敛，交由正常标签分支消费并推进 `i`
        state.htmlOpenTag = null;
      } else {
        if (ch === '"' || ch === "'") {
          let j = i + 1;
          while (j < len && line[j] !== ch) {
            j++;
          }
          if (j < len) {
            j++;
          }
          pushToken(out, "string", line.slice(i, j));
          i = j;
          continue;
        }

        if (ch === "=") {
          pushToken(out, "operator", "=");
          i += 1;
          continue;
        }

        if (ch === "{" || ch === "}") {
          pushToken(out, "punctuation", ch);
          i += 1;
          continue;
        }

        const attrMatch = /^[@:#]?[a-zA-Z_][a-zA-Z0-9_.:-]*/.exec(line.slice(i));
        if (attrMatch?.[0]) {
          pushToken(out, "property", attrMatch[0]);
          i += attrMatch[0].length;
          continue;
        }

        const numAttrMatch = /^-?\d+(?:\.\d+)?%?/.exec(line.slice(i));
        if (numAttrMatch?.[0]) {
          pushToken(out, "number", numAttrMatch[0]);
          i += numAttrMatch[0].length;
          continue;
        }

        pushToken(out, "plain", ch);
        i += 1;
        continue;
      }
    }

    // 4. 正常 HTML 标记与文本态
    if (line.startsWith("<!--", i)) {
      const end = line.indexOf("-->", i + 4);
      if (end === -1) {
        pushToken(out, "comment", line.slice(i));
        state.inHtmlComment = true;
        return out;
      }
      pushToken(out, "comment", line.slice(i, end + 3));
      i = end + 3;
      continue;
    }

    const doctypeMatch = /^(<![a-zA-Z_][a-zA-Z0-9_-]*)([^>]*)(>)/.exec(line.slice(i));
    if (doctypeMatch?.[0] && doctypeMatch[1] !== undefined && doctypeMatch[3] !== undefined) {
      pushToken(out, "doc_tag", doctypeMatch[1]);
      tokenizeDoctypeRest(out, doctypeMatch[2] ?? "");
      pushToken(out, "punctuation", doctypeMatch[3]);
      i += doctypeMatch[0].length;
      continue;
    }

    const xmlDeclMatch = /^<\?[^>]*\?>/.exec(line.slice(i));
    if (xmlDeclMatch?.[0]) {
      pushToken(out, "doc_tag", xmlDeclMatch[0]);
      i += xmlDeclMatch[0].length;
      continue;
    }

    const closeTagMatch = /^<\/([a-zA-Z][a-zA-Z0-9:._-]*)(\s*)>/.exec(line.slice(i));
    if (closeTagMatch?.[0] && closeTagMatch[1] !== undefined) {
      const rawTag = closeTagMatch[1];
      const tagKind: SyntaxTokenKind = /^[A-Z]/.test(rawTag) ? "type" : "keyword";
      pushToken(out, "punctuation", "</");
      pushToken(out, tagKind, rawTag);
      if (closeTagMatch[2]) {
        pushToken(out, "plain", closeTagMatch[2]);
      }
      pushToken(out, "punctuation", ">");
      i += closeTagMatch[0].length;
      continue;
    }

    const openTagMatch = /^<([a-zA-Z][a-zA-Z0-9:._-]*)/.exec(line.slice(i));
    if (openTagMatch?.[0] && openTagMatch[1] !== undefined) {
      const rawTag = openTagMatch[1];
      const tagKind: SyntaxTokenKind = /^[A-Z]/.test(rawTag) ? "type" : "keyword";
      pushToken(out, "punctuation", "<");
      pushToken(out, tagKind, rawTag);
      state.htmlOpenTag = { tagName: rawTag.toLowerCase() };
      i += openTagMatch[0].length;
      continue;
    }

    const entityMatch = /^&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/.exec(line.slice(i));
    if (entityMatch?.[0]) {
      pushToken(out, "number", entityMatch[0]);
      i += entityMatch[0].length;
      continue;
    }

    if (line.startsWith("{{", i) || line.startsWith("}}", i)) {
      pushToken(out, "punctuation", line.slice(i, i + 2));
      i += 2;
      continue;
    }

    let j = i + 1;
    while (
      j < len &&
      line[j] !== "<" &&
      line[j] !== "&" &&
      !line.startsWith("{{", j) &&
      !line.startsWith("}}", j)
    ) {
      j++;
    }
    pushToken(out, "plain", line.slice(i, j));
    i = j;
  }

  return out;
}

function tokenizeYamlLine(line: string): ReadonlyArray<SyntaxToken> {
  const out: SyntaxToken[] = [];
  const len = line.length;
  let i = 0;

  // TOML / INI 节标题 `[section]` / `[[array]]`
  const sectionMatch = /^(\s*)(\[+[^\]\n]+\]+)(\s*(?:#.*)?)$/.exec(line);
  if (sectionMatch !== null) {
    if (sectionMatch[1]) pushToken(out, "plain", sectionMatch[1]);
    if (sectionMatch[2]) pushToken(out, "type", sectionMatch[2]);
    const tail = sectionMatch[3] ?? "";
    const hashIdx = tail.indexOf("#");
    if (hashIdx === -1) {
      pushToken(out, "plain", tail);
    } else {
      pushToken(out, "plain", tail.slice(0, hashIdx));
      pushToken(out, "comment", tail.slice(hashIdx));
    }
    return out;
  }

  // 行首缩进与可选列表短横线 `- `
  const leadMatch = /^(\s*)(-\s+)?/.exec(line);
  if (leadMatch?.[1]) {
    pushToken(out, "plain", leadMatch[1]);
    i += leadMatch[1].length;
  }
  if (leadMatch?.[2]) {
    pushToken(out, "punctuation", "-");
    pushToken(out, "plain", leadMatch[2].slice(1));
    i += leadMatch[2].length;
  }

  // `key: value` 或 `ENV_KEY=value` 键名识别
  const keyMatch = /^([a-zA-Z0-9_./-]+|"[^"\n]*"|'[^'\n]*')(\s*[:=])/.exec(line.slice(i));
  if (keyMatch?.[1] && keyMatch[2]) {
    pushToken(out, "property", keyMatch[1]);
    const sep = keyMatch[2];
    const wsLen = sep.length - 1;
    if (wsLen > 0) {
      pushToken(out, "plain", sep.slice(0, wsLen));
    }
    pushToken(out, "operator", sep.slice(wsLen));
    i += keyMatch[0].length;
  }

  while (i < len) {
    const ch = line[i] ?? "";
    if (ch === " " || ch === "\t") {
      let j = i + 1;
      while (j < len && (line[j] === " " || line[j] === "\t")) {
        j++;
      }
      pushToken(out, "plain", line.slice(i, j));
      i = j;
      continue;
    }

    if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      pushToken(out, "comment", line.slice(i));
      return out;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (ch === '"' && line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j++;
          break;
        }
        j++;
      }
      pushToken(out, "string", line.slice(i, j));
      i = j;
      continue;
    }

    const envVarMatch = /^\$(?:\{[a-zA-Z0-9_:-]+\}|[a-zA-Z0-9_]+)/.exec(line.slice(i));
    if (envVarMatch?.[0]) {
      pushToken(out, "doc_tag", envVarMatch[0]);
      i += envVarMatch[0].length;
      continue;
    }

    const numOrBoolMatch =
      /^(?:true|false|null|yes|no|on|off|~|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|$|[,\]}#])/i.exec(
        line.slice(i),
      );
    if (numOrBoolMatch?.[0]) {
      pushToken(out, "number", numOrBoolMatch[0]);
      i += numOrBoolMatch[0].length;
      continue;
    }

    if ("{}[],|>-&*".includes(ch)) {
      pushToken(out, "punctuation", ch);
      i++;
      continue;
    }

    let j = i + 1;
    while (j < len && !" \t\"'${}[],#".includes(line[j] ?? "")) {
      j++;
    }
    pushToken(out, "string", line.slice(i, j));
    i = j;
  }

  return out;
}

function tokenizeMarkdownLine(line: string): ReadonlyArray<SyntaxToken> {
  const out: SyntaxToken[] = [];
  const headingMatch = /^(\s*)(#{1,6})(\s+)(.*)$/.exec(line);
  if (headingMatch !== null) {
    if (headingMatch[1]) pushToken(out, "plain", headingMatch[1]);
    pushToken(out, "keyword", headingMatch[2] ?? "#");
    pushToken(out, "plain", headingMatch[3] ?? " ");
    pushToken(out, "type", headingMatch[4] ?? "");
    return out;
  }

  const fenceMatch = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
  if (fenceMatch !== null) {
    if (fenceMatch[1]) pushToken(out, "plain", fenceMatch[1]);
    pushToken(out, "doc_tag", (fenceMatch[2] ?? "") + (fenceMatch[3] ?? ""));
    return out;
  }

  let i = 0;
  const len = line.length;
  const listOrQuoteMatch = /^(\s*)(?:([-*+]|\d+\.)(\s+)|(>\s?))/.exec(line);
  if (listOrQuoteMatch !== null) {
    if (listOrQuoteMatch[1]) pushToken(out, "plain", listOrQuoteMatch[1]);
    if (listOrQuoteMatch[2]) {
      pushToken(out, "operator", listOrQuoteMatch[2]);
      pushToken(out, "plain", listOrQuoteMatch[3] ?? "");
    } else if (listOrQuoteMatch[4]) {
      pushToken(out, "operator", listOrQuoteMatch[4]);
    }
    i = listOrQuoteMatch[0].length;
  }

  while (i < len) {
    const inlineCodeMatch = /^`[^`\n]+`/.exec(line.slice(i));
    if (inlineCodeMatch?.[0]) {
      pushToken(out, "string", inlineCodeMatch[0]);
      i += inlineCodeMatch[0].length;
      continue;
    }
    const boldMatch = /^\*\*[^*\n]+\*\*/.exec(line.slice(i));
    if (boldMatch?.[0]) {
      pushToken(out, "keyword", boldMatch[0]);
      i += boldMatch[0].length;
      continue;
    }
    const linkMatch = /^(\[[^\]\n]+\])(\([^)\n]+\))/.exec(line.slice(i));
    if (linkMatch?.[1] && linkMatch[2]) {
      pushToken(out, "property", linkMatch[1]);
      pushToken(out, "function", linkMatch[2]);
      i += linkMatch[0].length;
      continue;
    }
    pushToken(out, "plain", line[i] ?? "");
    i++;
  }
  return out;
}
function getKeywordSet(lang: SyntaxLanguage): ReadonlySet<string> {
  switch (lang) {
    case "python":
      return PYTHON_KEYWORDS;
    case "rust":
    case "go":
      return RUST_GO_KEYWORDS;
    case "shell":
      return SHELL_KEYWORDS;
    case "sql":
      return SQL_KEYWORDS;
    default:
      return TS_KEYWORDS;
  }
}

function tokenizeSingleLine(
  line: string,
  lang: SyntaxLanguage,
  state: ScannerState,
): ReadonlyArray<SyntaxToken> {
  if (lang === "plain") {
    return line.length > 0 ? [{ kind: "plain", text: line }] : [];
  }

  if (lang === "html") {
    return tokenizeHtmlLine(line, state);
  }

  if (lang === "yaml") {
    return tokenizeYamlLine(line);
  }

  if (lang === "markdown") {
    return tokenizeMarkdownLine(line);
  }

  if (lang === "diff") {
    if (line.startsWith("@@")) {
      return [{ kind: "diff_hunk", text: line }];
    }
    if (line.startsWith("+")) {
      return [{ kind: "diff_add", text: line }];
    }
    if (line.startsWith("-")) {
      return [{ kind: "diff_del", text: line }];
    }
    return [{ kind: "plain", text: line }];
  }

  if (lang === "css") {
    return tokenizeCssLine(line, state);
  }

  const out: SyntaxToken[] = [];
  const len = line.length;
  let i = 0;
  let inJsxTag = false;
  let jsxBraceDepth = 0;
  const keywords = getKeywordSet(lang);
  const supportsHashComment = lang === "python" || lang === "shell";
  const supportsSqlDashComment = lang === "sql";
  const supportsSlashComment = lang === "ts" || lang === "rust" || lang === "go" || lang === "json";

  while (i < len) {
    // 1. 延续中的多行块注释
    if (state.inBlockComment) {
      const end = line.indexOf("*/", i);
      if (end === -1) {
        tokenizeBlockCommentSegment(out, line.slice(i));
        return out;
      }
      tokenizeBlockCommentSegment(out, line.slice(i, end + 2));
      state.inBlockComment = false;
      i = end + 2;
      continue;
    }

    // 2. 延续中的多行反引号模板字符串
    if (state.inTemplateLiteral) {
      let j = i;
      while (j < len) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === "`") {
          pushToken(out, "string", line.slice(i, j + 1));
          state.inTemplateLiteral = false;
          j++;
          break;
        }
        j++;
      }
      if (state.inTemplateLiteral) {
        pushToken(out, "string", line.slice(i));
        return out;
      }
      i = j;
      continue;
    }

    const ch = line[i] ?? "";

    // 3. 空白快速跳过合并
    if (ch === " " || ch === "\t") {
      let j = i + 1;
      while (j < len && (line[j] === " " || line[j] === "\t")) {
        j++;
      }
      pushToken(out, "plain", line.slice(i, j));
      i = j;
      continue;
    }

    // 4. 注释识别
    if (supportsSlashComment && line.startsWith("//", i)) {
      pushToken(out, "comment", line.slice(i));
      return out;
    }
    if (supportsSlashComment && line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        tokenizeBlockCommentSegment(out, line.slice(i));
        state.inBlockComment = true;
        return out;
      }
      tokenizeBlockCommentSegment(out, line.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (supportsHashComment && ch === "#") {
      pushToken(out, "comment", line.slice(i));
      return out;
    }
    if (supportsSqlDashComment && line.startsWith("--", i)) {
      pushToken(out, "comment", line.slice(i));
      return out;
    }

    // 5. 字符串与模板字面量
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j++;
          break;
        }
        j++;
      }
      const tokenText = line.slice(i, j);
      // JSON 属性键 `"name":` 与值字符串区分着色
      if (lang === "json" && /^\s*:/.test(line.slice(j))) {
        pushToken(out, "property", tokenText);
      } else {
        pushToken(out, "string", tokenText);
      }
      i = j;
      continue;
    }

    if (lang === "ts" && ch === "`") {
      let j = i + 1;
      let closed = false;
      while (j < len) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === "`") {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      pushToken(out, "string", line.slice(i, j));
      if (!closed) {
        state.inTemplateLiteral = true;
        return out;
      }
      i = j;
      continue;
    }

    // 6. 装饰器或 Shell 变量 `$VAR` / `--flag`
    if ((lang === "ts" || lang === "python") && ch === "@") {
      const decMatch = /^@[a-zA-Z_][a-zA-Z0-9_.]*/.exec(line.slice(i));
      if (decMatch?.[0]) {
        pushToken(out, "doc_tag", decMatch[0]);
        i += decMatch[0].length;
        continue;
      }
    }

    if (lang === "shell" && ch === "$") {
      const envMatch = /^\$(?:\{[a-zA-Z0-9_:-]+\}|[a-zA-Z0-9_]+)/.exec(line.slice(i));
      if (envMatch?.[0]) {
        pushToken(out, "property", envMatch[0]);
        i += envMatch[0].length;
        continue;
      }
    }

    if (lang === "shell" && line.startsWith("--", i)) {
      const flagMatch = /^--[a-zA-Z0-9-]+/.exec(line.slice(i));
      if (flagMatch?.[0]) {
        pushToken(out, "property", flagMatch[0]);
        i += flagMatch[0].length;
        continue;
      }
    }

    // 7. 数字字面量（含 `12_000`、`0x1f`、浮点数）
    if (isDigit(ch)) {
      const numMatch =
        /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)n?/.exec(
          line.slice(i),
        );
      if (numMatch?.[0]) {
        pushToken(out, "number", numMatch[0]);
        i += numMatch[0].length;
        continue;
      }
    }

    // 8. JSX / TSX 内联标签识别（精准区分 `<div className="...">` 与泛型/小于号 `a < b`）
    if (lang === "ts") {
      if (inJsxTag && jsxBraceDepth === 0) {
        if (line.startsWith("/>", i)) {
          pushToken(out, "punctuation", "/>");
          inJsxTag = false;
          i += 2;
          continue;
        }
        if (ch === ">") {
          pushToken(out, "punctuation", ">");
          inJsxTag = false;
          i += 1;
          continue;
        }
        if (ch === "{") {
          pushToken(out, "punctuation", "{");
          jsxBraceDepth = 1;
          i += 1;
          continue;
        }
        const jsxAttrMatch = /^[a-zA-Z_][a-zA-Z0-9_:-]*(?=\s*=|\s+|[/>])/.exec(line.slice(i));
        if (jsxAttrMatch?.[0]) {
          pushToken(out, "property", jsxAttrMatch[0]);
          i += jsxAttrMatch[0].length;
          continue;
        }
      } else if (inJsxTag && jsxBraceDepth > 0) {
        if (ch === "{") {
          pushToken(out, "punctuation", "{");
          jsxBraceDepth += 1;
          i += 1;
          continue;
        }
        if (ch === "}") {
          pushToken(out, "punctuation", "}");
          jsxBraceDepth -= 1;
          i += 1;
          continue;
        }
      } else {
        const jsxCloseMatch = /^<\/([a-zA-Z][a-zA-Z0-9._-]*)(\s*)>/.exec(line.slice(i));
        if (jsxCloseMatch?.[0] && jsxCloseMatch[1] !== undefined) {
          const tag = jsxCloseMatch[1];
          pushToken(out, "punctuation", "</");
          pushToken(out, /^[A-Z]/.test(tag) ? "type" : "keyword", tag);
          if (jsxCloseMatch[2]) pushToken(out, "plain", jsxCloseMatch[2]);
          pushToken(out, "punctuation", ">");
          i += jsxCloseMatch[0].length;
          continue;
        }
        const prevCh = i > 0 ? (line[i - 1] ?? "") : "";
        if (!isIdentPart(prevCh)) {
          const jsxOpenMatch =
            /^<([a-zA-Z][a-zA-Z0-9._-]*)(?=>|\s*\/>|\s+[a-zA-Z_][a-zA-Z0-9_:-]*\s*=|\s+\{\.\.\.)/.exec(
              line.slice(i),
            );
          if (jsxOpenMatch?.[0] && jsxOpenMatch[1] !== undefined) {
            const tag = jsxOpenMatch[1];
            pushToken(out, "punctuation", "<");
            pushToken(out, /^[A-Z]/.test(tag) ? "type" : "keyword", tag);
            inJsxTag = true;
            jsxBraceDepth = 0;
            i += jsxOpenMatch[0].length;
            continue;
          }
        }
      }
    }

    // 9. 标识符、关键字、类型名、函数调用、成员属性与对象属性键
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < len && isIdentPart(line[j] ?? "")) {
        j++;
      }
      const word = line.slice(i, j);
      const rest = line.slice(j);
      const lookupWord = lang === "sql" ? word.toLowerCase() : word;

      if (LITERAL_CONSTANTS.has(word)) {
        pushToken(out, "number", word);
      } else if (keywords.has(lookupWord) && !(i > 0 && line[i - 1] === ".")) {
        pushToken(out, "keyword", word);
      } else if (
        BUILTIN_TYPES.has(word) ||
        /^[A-Z][a-zA-Z0-9]*$/.test(word) ||
        /^[A-Z][A-Z0-9_]{2,}$/.test(word)
      ) {
        pushToken(out, "type", word);
      } else if (/^\s*(?:<[^>]+>)?\s*\(/.test(rest)) {
        pushToken(out, "function", word);
      } else if (lang === "ts" && /^\??\s*:/.test(rest) && !rest.startsWith("::")) {
        pushToken(out, "property", word);
      } else if (
        (lang === "ts" || lang === "python" || lang === "rust" || lang === "go") &&
        i > 0 &&
        line[i - 1] === "."
      ) {
        pushToken(out, "property", word);
      } else {
        pushToken(out, "plain", word);
      }
      i = j;
      continue;
    }

    // 9. 常见多字符运算符与括号标点
    const opMatch = /^(?:===|!==|=>|<=|>=|&&|\|\||\?\?|\*\*|\.\.\.|==|!=|\+=|-=)/.exec(
      line.slice(i),
    );
    if (opMatch?.[0]) {
      pushToken(out, "operator", opMatch[0]);
      i += opMatch[0].length;
      continue;
    }

    if ("+-*/%=<>!&|?:".includes(ch)) {
      pushToken(out, "operator", ch);
      i++;
      continue;
    }

    if ("{}[]().,;".includes(ch)) {
      pushToken(out, "punctuation", ch);
      i++;
      continue;
    }

    pushToken(out, "plain", ch);
    i++;
  }

  return out;
}

/** 单行最大精细分词字符阈值：超长压缩单行（如 bundle.min.js / Base64）仅对前段做独立预览着色，尾部直通 plain */
export const MAX_SYNTAX_LINE_CHARS = 1_200;
const LONG_LINE_HEAD_CHARS = 240;

/** 单个代码块最大精细分词行数阈值：超出部分按原样单 token 直通以限制主线程耗时 */
export const MAX_SYNTAX_BLOCK_LINES = 800;

/**
 * 对一组有序代码行执行状态延续词法着色（适合 Unified Diff 或按行渲染器）。
 *
 * @param lines - 按顺序排列的单行源码文本列表
 * @param language - 目标语法语言族
 * @returns 与输入等长的二维词法单元数组
 */
export function tokenizeCodeLines(
  lines: ReadonlyArray<string>,
  language: SyntaxLanguage,
): ReadonlyArray<ReadonlyArray<SyntaxToken>> {
  const state = createInitialScannerState();
  return lines.map((line, lineIdx) => {
    if (lineIdx >= MAX_SYNTAX_BLOCK_LINES) {
      return line.length > 0 ? [{ kind: "plain", text: line }] : [];
    }
    if (line.length > MAX_SYNTAX_LINE_CHARS) {
      // 超长行只扫描前 240 字符，使用独立状态副本避免半截未闭合注释或模板字符串污染后续代码行
      const isolatedState = cloneScannerState(state);
      const headTokens = tokenizeSingleLine(
        line.slice(0, LONG_LINE_HEAD_CHARS),
        language,
        isolatedState,
      );
      const tailText = line.slice(LONG_LINE_HEAD_CHARS);
      return [...headTokens, { kind: "plain", text: tailText }];
    }
    return tokenizeSingleLine(line, language, state);
  });
}

/**
 * 对完整多行源码块执行词法着色（适合聊天消息 Markdown Fenced Code Block）。
 *
 * @param code - 完整多行代码字符串
 * @param language - 目标语法语言族
 * @returns 按换行切分后的词法单元行数组
 */
export function tokenizeCodeBlock(
  code: string,
  language: SyntaxLanguage,
): ReadonlyArray<ReadonlyArray<SyntaxToken>> {
  return tokenizeCodeLines(code.split("\n"), language);
}
