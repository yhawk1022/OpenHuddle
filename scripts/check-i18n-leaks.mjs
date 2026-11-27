#!/usr/bin/env node
/**
 * Scans apps/web/src (excluding tests and *.zh-CN.ts catalogs) using TypeScript's
 * lexical scanner so comments/JSDoc are skipped while untranslated CJK string
 * literals, template chunks, and JSX text nodes are caught automatically.
 *
 * Lines containing `i18n-ignore` (e.g. native language autonym "简体中文") are skipped.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const HAN_RE = /\p{Script=Han}/u;
const TARGET = path.resolve(process.cwd(), process.argv[2] ?? "apps/web/src");

function isTranslatableSource(name) {
  return (
    (name.endsWith(".ts") || name.endsWith(".tsx")) &&
    !name.endsWith(".test.ts") &&
    !name.endsWith(".test.tsx") &&
    !name.endsWith(".zh-CN.ts") &&
    name !== "zh-CN.ts"
  );
}

function walk(targetPath, out = []) {
  const st = statSync(targetPath);
  if (!st.isDirectory()) {
    if (isTranslatableSource(path.basename(targetPath))) {
      out.push(targetPath);
    }
    return out;
  }
  for (const entry of readdirSync(targetPath)) {
    const full = path.join(targetPath, entry);
    const entryStat = statSync(full);
    if (entryStat.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") {
        continue;
      }
      walk(full, out);
    } else if (isTranslatableSource(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(TARGET).sort();
let totalLeaks = 0;
const byFile = [];

for (const file of files) {
  const sourceText = readFileSync(file, "utf8");
  if (!HAN_RE.test(sourceText)) {
    continue;
  }
  const lines = sourceText.split(/\r?\n/);
  const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, false, scriptKind);
  const fileLeaks = [];

  function visit(node) {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const text = node.text;
      if (HAN_RE.test(text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const rawLine = lines[line] ?? "";
        const prevLine = lines[line - 1] ?? "";
        if (!rawLine.includes("i18n-ignore") && !prevLine.includes("i18n-ignore")) {
          fileLeaks.push({
            line: line + 1,
            snippet: text.replace(/\s+/gu, " ").trim().slice(0, 80),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  if (fileLeaks.length > 0) {
    totalLeaks += fileLeaks.length;
    byFile.push({ file: path.relative(process.cwd(), file), leaks: fileLeaks });
  }
}

if (byFile.length === 0) {
  console.info("OK: zero untranslated CJK string literals or JSX text nodes found.");
  process.exit(0);
}

for (const item of byFile) {
  console.info(`${item.file} (${item.leaks.length}):`);
  for (const leak of item.leaks.slice(0, 10)) {
    console.info(`  L${leak.line}: ${leak.snippet}`);
  }
  if (item.leaks.length > 10) {
    console.info(`  ... and ${item.leaks.length - 10} more`);
  }
}
console.error(`\nFOUND ${totalLeaks} untranslated CJK nodes across ${byFile.length} files.`);
process.exit(1);
