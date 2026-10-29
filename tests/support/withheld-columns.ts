// The columns a signed-in user may not SELECT, and the select strings the app
// sends, read out of src/ so the tests that use them cannot drift from it.
//
// #492: 20261015215000 replaced authenticated's table SELECT on properties
// with a column grant that leaves out the access codes. The production build
// still selected gate_code, PostgREST answered 403 on every My Day, visit
// detail and client properties request, and nothing in CI had run one of
// those queries against the narrowed grants. Three tests now read this file:
//
//   * a-browser-query-never-names-a-withheld-column.test.ts (every PR): no
//     select outside a service-role call site names one of these columns.
//   * a-new-column-is-granted-or-withheld-on-purpose.test.ts (every PR): a
//     migration that adds a column to one of these tables grants it, or the
//     column is listed here; nothing puts a table grant back.
//   * tests/integration/my-day-loads-under-the-narrowed-grants.db.test.ts
//     (sandboxes database job): the app's own select strings, run as the
//     owner and as the walker against a database built from the migrations.
//
// supabase/proofs/20261029180000-a-narrowed-grant-withholds-only-what-it-names.sql
// holds the same list in SQL and asserts it against the catalog. The static
// test checks the two copies agree.

import ts from "typescript";

export type NarrowedTable = {
  /** The migration that replaced the table grant with a column grant. */
  narrowedBy: string;
  /** Columns authenticated may not SELECT. Every other column is granted. */
  withheld: readonly string[];
  /** How a signed-in user reads the withheld columns instead, if at all. */
  readThrough: string;
};

export const NARROWED_TABLES: Readonly<Record<string, NarrowedTable>> = {
  properties: {
    narrowedBy: "20261015215000_a-lock-box-code-is-for-the-assigned-day.sql",
    withheld: ["alarm_notes", "gate_code", "key_location", "key_tag", "lock_box_code"],
    readThrough: "property_access_codes or stay_access_codes",
  },
  accounting_connections: {
    narrowedBy: "20261009161500_quickbooks-for-real.sql",
    withheld: ["access_token", "refresh_token"],
    readThrough: "nothing: the tokens are read on the service role only",
  },
};

export const WITHHELD_COLUMNS: readonly string[] = [
  ...new Set(Object.values(NARROWED_TABLES).flatMap((t) => t.withheld)),
].sort();

export type SelectCall = {
  /** 1-based line of the `.select(` call. */
  line: number;
  /** The table named by the nearest `.from("...")` in the chain, if any. */
  table: string | null;
  /** The select string, with same-file string constants substituted. Null
   *  when the argument is not something this can read statically. */
  columns: string | null;
};

/** Every `.select(...)` call in a file, with the table and the column string
 *  where they can be read without running the code. A same-file `const X =
 *  "..."` passed to select (portal-access.functions.ts does this) is resolved,
 *  and so is one spliced into a template. */
export function selectCalls(file: string, text: string): SelectCall[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);

  const consts = new Map<string, string>();
  const stringOf = (node: ts.Node | undefined): string | null => {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text];
      for (const span of node.templateSpans) {
        parts.push(stringOf(span.expression) ?? "", span.literal.text);
      }
      return parts.join("");
    }
    if (ts.isIdentifier(node)) return consts.get(node.text) ?? null;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return stringOf(node.expression);
    return null;
  };
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = stringOf(node.initializer);
      if (value != null) consts.set(node.name.text, value);
    }
    ts.forEachChild(node, collect);
  };
  collect(src);

  const tableOf = (call: ts.CallExpression): string | null => {
    let node: ts.Expression = call.expression;
    while (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "from"
      ) {
        return stringOf(node.arguments[0]);
      }
      node = node.expression;
    }
    return null;
  };

  const found: SelectCall[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "select"
    ) {
      found.push({
        line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        table: tableOf(node),
        columns: node.arguments.length === 0 ? "*" : stringOf(node.arguments[0]),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}

const WITHHELD = new RegExp(`\\b(${WITHHELD_COLUMNS.join("|")})\\b`, "g");

/** The withheld columns a select string names. */
export function withheldIn(columns: string): string[] {
  return [...new Set([...columns.matchAll(WITHHELD)].map((m) => m[1]))].sort();
}

/** Whether a select asks for every column of a narrowed table: `*` on the
 *  table itself, or an embed such as `properties(*)` or `p:properties!fk(*)`.
 *  PostgREST expands `*` to every column, the withheld ones included, and the
 *  request is refused. */
export function selectsEveryNarrowedColumn(call: SelectCall): string | null {
  const columns = call.columns ?? "";
  if (call.table && call.table in NARROWED_TABLES && /^\s*\*\s*(,|$)|,\s*\*\s*(,|$)/.test(columns))
    return call.table;
  for (const table of Object.keys(NARROWED_TABLES)) {
    if (new RegExp(`\\b${table}(![\\w]+)?\\s*\\(\\s*\\*\\s*[,)]`).test(columns)) return table;
  }
  return null;
}
