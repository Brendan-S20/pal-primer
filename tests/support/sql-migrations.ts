// Reading the migrations directory as SQL rather than as text.
//
// Two rules now replay the whole migration history to work out what the
// database ACTUALLY has — the `auth.uid()` wrapping rule
// (every-row-was-asked-again-who-was-asking) and the duplicate-policy rule
// (forty-three-pairs-of-policies-asked-the-same-question-twice). Both needed
// the same two pieces of lexing, and both need them to be exactly right,
// because both migrations quote the pattern they ban in their own prose.
//
// Lives here rather than being copied into each test so there is one place
// where "is this a statement" is decided. The replay ON TOP of these — what a
// CREATE/ALTER/DROP POLICY means, what fields it carries — differs between the
// two rules and stays in each test file.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
export const MIGRATIONS = join(ROOT, "supabase", "migrations");

/** Read lazily. A file read resolved while the module is loading turns a
 *  missing file into an import-time throw, and vitest reports an import-time
 *  throw as "no tests" — which reads as a pass. */
export const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();

export const readMigration = (f: string): string => readFileSync(join(MIGRATIONS, f), "utf8");

/** Strip `--` comments without being fooled by one inside a string literal.
 *  The prose in these migrations quotes the very pattern being banned, so a
 *  rule that reads comments reports its own documentation as a violation. */
export function stripLineComments(sql: string): string {
  // `/\r?\n/` rather than `"\n"`: a Windows runner joined the pool on
  // 2026-09-16 and Git there checks out CRLF, which left a trailing \r on
  // every line and made every anchored pattern below miss. `.gitattributes`
  // now pins eol=lf so this should never see CRLF again — this is the belt to
  // that brace, in the one helper every SQL-reading suite goes through.
  return sql
    .split(/\r?\n/)
    .map((line) => {
      let out = "";
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          out += c;
          if (c === quote) quote = null;
          continue;
        }
        if (c === "'" || c === '"') {
          quote = c;
          out += c;
          continue;
        }
        if (c === "-" && line[i + 1] === "-") break;
        out += c;
      }
      return out;
    })
    .join("\n");
}

/** Split on `;` at the top level, respecting quotes and dollar-quoted bodies —
 *  these migrations are full of `DO $pre$ ... $pre$;` blocks whose contents
 *  contain semicolons that do not end a statement. */
export function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let dollar: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        cur += sql.slice(i, i + dollar.length);
        i += dollar.length - 1;
        dollar = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    const tag = /^\$[a-zA-Z_]*\$/.exec(sql.slice(i));
    if (tag) {
      dollar = tag[0];
      cur += dollar;
      i += dollar.length - 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export const IDENT = String.raw`("(?:[^"]|"")+"|[A-Za-z_][A-Za-z_0-9$]*)`;

export const unquote = (s: string): string =>
  s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s;
