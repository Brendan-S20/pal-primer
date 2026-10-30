// Every `.from("table") ... .select("...")` in src/, and the embeds inside it.
//
// Shared by the two halves of #603's contract: the static check, which reads
// the foreign keys from src/integrations/supabase/types.ts and runs anywhere,
// and the database check, which asks a real PostgREST built from the
// migrations. Both need the same list of select strings and the same reading
// of what an embed is, so it lives here once.
//
// A select is only collected when its table and its string are both known
// without running the code: a string literal, a template with no `${}`, or a
// `const` in the same file holding one of those. Anything built at runtime is
// counted as skipped, so a test can say how much it did not see.

import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./repo-paths";

export type SelectSite = { file: string; line: number; table: string; select: string };

export type Embed = {
  /** The table the embed hangs off: the `.from()` table, or the embed above it. */
  parent: string;
  /** The table PostgREST is asked to join. */
  target: string;
  /** What follows `!`, without `inner` / `left`: a foreign key or a column. */
  hint: string | null;
  /** The text as written, for the failure message. */
  text: string;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The string an expression always evaluates to, when that can be read off
 *  the source: literals, `+` of those, a template whose `${}` are themselves
 *  readable, and a `const` in the same file holding any of these. */
function stringOf(node: ts.Node | undefined, consts?: Map<string, string>): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return stringOf(node.expression, consts);
  if (ts.isIdentifier(node)) return consts?.get(node.text) ?? null;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = stringOf(node.left, consts);
    const b = stringOf(node.right, consts);
    return a === null || b === null ? null : a + b;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const v = stringOf(span.expression, consts);
      if (v === null) return null;
      out += v + span.literal.text;
    }
    return out;
  }
  return null;
}

/** The `.from("x")` a call chain started from, or null if it started anywhere
 *  else (an `.rpc()`, a storage bucket, a variable holding a query). */
function fromTable(expr: ts.Expression): string | null {
  let e: ts.Expression = expr;
  while (true) {
    if (ts.isCallExpression(e)) {
      const callee = e.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        if (name === "from") return stringOf(e.arguments[0]);
        if (name === "rpc") return null;
        e = callee.expression;
        continue;
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(e)) {
      e = e.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) {
      e = e.expression;
      continue;
    }
    return null;
  }
}

export function collectSelects(root: string): { sites: SelectSite[]; skipped: SelectSite[] } {
  const sites: SelectSite[] = [];
  const skipped: SelectSite[] = [];
  for (const path of walk(join(root, "src"))) {
    const text = readFileSync(path, "utf8");
    if (!text.includes(".select(")) continue;
    const file = repoRelative(path, root);
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const consts = new Map<string, string>();
    const visitConsts = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        const s = stringOf(n.initializer, consts);
        if (s !== null) consts.set(n.name.text, s);
      }
      ts.forEachChild(n, visitConsts);
    };
    visitConsts(sf);
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "select"
      ) {
        const table = fromTable(n.expression.expression);
        if (table) {
          const arg = n.arguments[0];
          const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
          const select = stringOf(arg, consts);
          if (select !== null) sites.push({ file, line, table, select });
          else if (arg) skipped.push({ file, line, table, select: arg.getText(sf) });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { sites, skipped };
}

/** Split at commas that are not inside parentheses. */
function topLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const EMBED_HEAD = /^(?:\.\.\.)?(?:\w+:)?(\w+)((?:!\w+)*)$/;

/** Every embed in a select string, nested ones included, each with its parent.
 *
 *  `staff:assigned_staff_id(...)` names the foreign key COLUMN rather than the
 *  table, which PostgREST reads as the table that column points at, already
 *  disambiguated. Given the foreign keys, that becomes a table and a hint, so
 *  the embeds nested inside it get the right parent too. */
export function embedsOf(table: string, select: string, fks: Fk[] = []): Embed[] {
  const out: Embed[] = [];
  for (const item of topLevel(select.replace(/\s+/g, " "))) {
    const open = item.indexOf("(");
    if (open < 0 || !item.endsWith(")")) continue;
    const head = item.slice(0, open).trim();
    const m = EMBED_HEAD.exec(head);
    // `count()` and the other aggregates are not embeds.
    if (!m) continue;
    if (/^(count|sum|avg|min|max)$/.test(m[1]) && !item.slice(open + 1, -1).trim()) continue;
    const hints = m[2]
      .split("!")
      .filter(Boolean)
      .filter((h) => h !== "inner" && h !== "left");
    let target = m[1];
    let hint = hints[0] ?? null;
    const viaColumn = fks.find(
      (f) => f.from === table && f.columns.length === 1 && f.columns[0] === target,
    );
    if (viaColumn) {
      target = viaColumn.to;
      hint ??= viaColumn.name;
    }
    out.push({ parent: table, target, hint, text: head });
    out.push(...embedsOf(target, item.slice(open + 1, -1), fks));
  }
  return out;
}

export type Fk = { name: string; from: string; columns: string[]; to: string };

/** The public schema's foreign keys, as types.ts was generated with them. */
export function foreignKeysFromTypes(typesTs: string): Fk[] {
  const start = typesTs.indexOf("  public: {\n    Tables: {");
  const end = typesTs.indexOf("\n    Views: {", start);
  const body = typesTs.slice(start, end);
  const fks: Fk[] = [];
  const tableRe = /^ {6}(\w+): \{\n {8}Row: \{/gm;
  const heads = [...body.matchAll(tableRe)];
  heads.forEach((h, i) => {
    const chunk = body.slice(h.index!, heads[i + 1]?.index ?? body.length);
    const rels = chunk.slice(chunk.indexOf("Relationships: ["));
    for (const r of rels.matchAll(
      /foreignKeyName: "(\w+)"\s+columns: \[([^\]]*)\][\s\S]*?referencedRelation: "(\w+)"/g,
    )) {
      fks.push({
        name: r[1],
        from: h[1],
        columns: [...r[2].matchAll(/"(\w+)"/g)].map((c) => c[1]),
        to: r[3],
      });
    }
  });
  return fks;
}

/** The foreign keys PostgREST would weigh for parent -> target. Both
 *  directions count: that is exactly how services.public_package_id made
 *  service_packages -> services ambiguous (#603). */
export function candidates(fks: Fk[], parent: string, target: string): Fk[] {
  return fks.filter(
    (f) => (f.from === parent && f.to === target) || (f.from === target && f.to === parent),
  );
}
