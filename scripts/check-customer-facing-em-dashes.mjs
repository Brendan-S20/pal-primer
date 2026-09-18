#!/usr/bin/env node
// An em dash in copy a customer reads.
//
// ── WHY THE TYPESCRIPT PARSER AND NOT A GREP ──────────────────────────────
//
// This repo's source is roughly a third prose: files carry long explanatory
// headers and those headers are full of em dashes on purpose. A grep for "—"
// over src/ matches 352 files, nearly all comments, so its output is unusable
// and a --fix over it would rewrite the commentary and miss the copy.
//
// "Does a customer read this string" is a question about what KIND of node the
// dash sits in, which is a parsing question. The first version of this file
// was a hand-rolled character walker and it was WRONG in a way worth recording:
// every `=>` and every `a > b` looks like the `>` that closes a JSX tag, so it
// opened a text run and swallowed the following code and comments. It reported
// 177 findings, and the ones it named first were comments.
//
// So this asks the TypeScript parser instead. JsxText, StringLiteral,
// NoSubstitutionTemplateLiteral and TemplateSpan text are copy; comments are
// not nodes and never appear. Same reasoning as
// tests/a-flex-row-as-wide-as-its-longest-word.test.ts.
//
// ── WHAT IS DELIBERATELY NOT A VIOLATION ──────────────────────────────────
//
// - `/platform/*`, the internal admin console. Staff copy, owner's call
//   (2026-08-20), excluded by path rather than by hope.
// - A standalone "—" in a table or stat cell: the ordinary UI convention for
//   "no value". Detected as "the whole string is dashes and space", so
//   "— pending" is still caught.
// - Comments, tests and docs. Nobody buys anything from a code comment.
// - import/export specifiers and other non-copy strings are excluded by
//   checking the parent node, not by pattern.
//
// ── THE OPT-OUT, AND WHY IT IS A COMMENT AND NOT A PATH LIST ──────────────
//
// Two kinds of string survived the sweep on 2026-08-20 and neither is copy:
//
//   1. LLM PROMPTS. `ai-receptionist.server.ts` and `ai-tools.functions.ts`
//      hold instructions addressed to a model, not to a person. Rewording one
//      to satisfy a punctuation rule is editing behaviour to fix a typo.
//   2. THE SMS CONSENT SENTENCE. It is the compliance artifact: it is stored
//      verbatim per consent (`_text: SMS_CONSENT_TEXT`) so historical rows are
//      auditable, `/legal/sms` links screenshots showing that exact wording for
//      carrier review, and two tests pin it. Toll-free verification is open at
//      the time of writing, so changing the words on the page would put them
//      out of step with the evidence submitted.
//
// Both are marked at the site with `em-dash-ok: <reason>` rather than added to
// a path list here, because a path list silently grows to cover whole files and
// the next real finding in one of them disappears. A marker exempts the string
// it sits on and nothing else, and it has to carry a reason.

import { toPosix } from "./posix-path.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** Internal admin console: staff read it, customers do not. */
const isPlatform = (p) => /(^|\/)platform[.\-/]/.test(p);
const isTest = (p) => /\.(test|spec)\.[tj]sx?$/.test(p);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

/** Only dashes and whitespace: the empty-cell convention, not prose. */
const isPlaceholder = (s) => /^[\s—–-]*$/.test(s);

const hasDash = (s) => s.includes("—") || s.includes("&mdash;");

/** A string node that is machinery, not copy. */
function isNonCopyString(node) {
  const p = node.parent;
  if (!p) return false;
  return (
    ts.isImportDeclaration(p) ||
    ts.isExportDeclaration(p) ||
    ts.isModuleDeclaration(p) ||
    // obj["key"], and property NAMES (values still count)
    (ts.isPropertyAssignment(p) && p.name === node) ||
    ts.isElementAccessExpression(p) ||
    // className="..." and other attribute values that are not copy are still
    // reported: an em dash has no business in a class list, and if one shows
    // up it is worth a human look.
    false
  );
}

/**
 * Every em dash in copy a customer reads, for one file's source.
 *
 * Exported so the rules can be tested against fixture strings rather than
 * against whatever the repo happens to contain today: a guard whose only
 * evidence is "it passes on main" cannot tell a working rule from a broken one.
 */
export function scanSource(rel, src) {
  const findings = [];
  if (isPlatform(rel) || isTest(rel)) return findings;
  if (!hasDash(src)) return findings;

  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = src.split("\n");

  /**
   * A string is exempt if `em-dash-ok` sits just above the STATEMENT it belongs
   * to, not just above the string itself. A prompt is usually a chain of
   * concatenated literals, each of which is its own node starting on its own
   * line, so a fixed line window either misses the marker or is wide enough to
   * silently exempt the next real finding. Walking up to the enclosing
   * statement makes the marker's scope exactly the thing a human meant to
   * exempt: this prompt, this constant, this property.
   */
  const statementStartLine = (node) => {
    let cur = node;
    while (cur.parent) {
      if (
        ts.isPropertyAssignment(cur) ||
        ts.isVariableStatement(cur) ||
        ts.isExpressionStatement(cur) ||
        ts.isReturnStatement(cur) ||
        ts.isJsxElement(cur)
      ) {
        break;
      }
      cur = cur.parent;
    }
    return sf.getLineAndCharacterOfPosition(cur.getStart(sf)).line;
  };

  const exempted = (node, lineIdx) => {
    const start = statementStartLine(node);
    // Walk up through the comment block attached to the statement. A reason
    // worth writing is usually several lines long and the marker leads it, so a
    // fixed line count would find only short ones.
    let top = start;
    while (top > 0) {
      const prev = lines[top - 1].trim();
      if (prev.startsWith("//") || prev.startsWith("*") || prev.startsWith("/*") ||
          prev.startsWith("{/*") || prev === "") {
        top--;
      } else break;
    }
    return lines.slice(top, lineIdx + 1).some((l) => l.includes("em-dash-ok"));
  };

  const report = (node, text) => {
    if (!hasDash(text) || isPlaceholder(text)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    if (exempted(node, line)) return;
    findings.push({
      file: rel,
      line: line + 1,
      snippet: text.trim().replace(/\s+/g, " ").slice(0, 110),
    });
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) report(node, node.text);
    else if (ts.isStringLiteral(node) && !isNonCopyString(node)) report(node, node.text);
    else if (ts.isNoSubstitutionTemplateLiteral(node)) report(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      report(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

export function scanRepo() {
  const all = [];
  for (const file of walk(SRC)) {
    const rel = toPosix(relative(ROOT, file));
    all.push(...scanSource(rel, readFileSync(file, "utf8")));
  }
  return all;
}

// Run as a CLI only when invoked directly, so importing it in a test is free
// of side effects (and of process.exit).
const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("check-customer-facing-em-dashes.mjs");
if (!invokedDirectly) {
  // imported: nothing else to do
} else {
  main();
}

function main() {
const findings = scanRepo();
if (findings.length === 0) {
  console.log("✓ no em dashes in customer-facing copy");
  process.exit(0);
}

console.error(`✗ ${findings.length} em dash(es) in copy a customer reads:\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    ${f.snippet}`);
}
console.error("\nUse a comma, a period, a colon, parentheses, or rewrite the sentence.");
console.error("A standalone — as an empty-cell value is fine and is not reported.");
process.exit(1);
}
