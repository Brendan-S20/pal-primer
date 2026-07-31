#!/usr/bin/env node
// IMP-11 — fail loudly when something is BUILT but nothing calls it.
//
// This class of defect has appeared six times in one cycle, and every instance
// was invisible: no error, no failing test, no type complaint. Just a feature
// that quietly did nothing, discovered later by accident.
//
//   franchise_rollup()          granted to authenticated, called by nothing.
//                               Every franchise dashboard was blank, for
//                               everyone, always.
//   /hooks/weekly-digest        endpoint correct, no scheduler ever created.
//                               "Every Monday morning" never once happened.
//   plan_status = 'trialing'    enum value, billing branches, announcement
//                               audience — nothing ever entered the state.
//   set_location_payment_routing  three routing functions granted and
//   set_chargeback_responsibility unreachable from the product; the columns
//   set_child_royalty_percent     they write were enforced everywhere.
//   franchise_share_cents       written on every adjustment, read by nothing —
//                               and it was the missing term in the settlement
//                               formula (BUG-24), so locations were billed for
//                               refunds they had already paid.
//
// Tests do not catch this. A test proves the machinery works when called; it
// says nothing about whether anything calls it. Types do not catch it either —
// an uncalled function is perfectly well-typed.
//
// WHAT THIS DELIBERATELY IS NOT: a lint rule for unused code. It only looks at
// the seams where one system hands off to another — SQL→app, cron→endpoint,
// writer→reader — because that is where "nobody wired it up" hides. Unused
// TypeScript is already caught by the compiler and by review.
//
// FALSE POSITIVES ARE THE FAILURE MODE. check-migrations.mjs learned this: a
// naive diff there reported ~80 false hits and would have been ignored, which
// is worse than no check. So every rule here is conservative, every exception
// is recorded in dead-machinery-baseline.json WITH ITS REASON, and the check
// starts green.
//
// Usage:
//   node scripts/check-dead-machinery.mjs
//   node scripts/check-dead-machinery.mjs --json      (machine-readable)

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const SRC = join(ROOT, "src");
const BASELINE_PATH = join(ROOT, "scripts", "dead-machinery-baseline.json");

// ── file collection ────────────────────────────────────────────────────────

function walk(dir, filter, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, filter, acc);
    else if (filter(full)) acc.push(full);
  }
  return acc;
}

/** Every .ts/.tsx under src/, minus the generated files.
 *
 *  types.ts is excluded on purpose: it mentions every table, column and RPC in
 *  the database, so including it would make every check pass vacuously. Same
 *  for routeTree.gen.ts. */
function appSources() {
  return walk(SRC, (f) => /\.(ts|tsx)$/.test(f)).filter(
    (f) => !f.endsWith("types.ts") && !f.endsWith("routeTree.gen.ts"),
  );
}

function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(MIGRATIONS, f));
}

/** SQL with comments stripped.
 *
 *  These migrations carry long prose headers that name functions and columns
 *  while explaining them. Scanning raw text would count an explanation as a
 *  call — the exact trap the permission parity test fell into on an inline
 *  comment.
 *
 *  COMMENT ON … IS '…' goes too. It is a comment that happens to survive into
 *  the database, and its prose names things for the same reason: the review
 *  queue's table comment says "Detected by detect_review_items()", which reads
 *  as a call to that function from a string literal. */
function sqlCode(text) {
  return text
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/COMMENT\s+ON\s+[^;']*?\bIS\s+(?:'(?:[^']|'')*'|NULL)\s*;/gi, "");
}

/** TypeScript with comments stripped, for exactly the reason sqlCode() exists.
 *
 *  Rule 1 counts any mention of an RPC name in src/ as a caller, and a comment
 *  is a mention. `portal_resolve_contact` is granted to service_role, called
 *  from no TypeScript and no SQL, and it passed this check green because
 *  src/lib/portal-auth.server.ts says "This replaces the old
 *  portal_resolve_contact RPC" — the sentence announcing its retirement was
 *  read as proof that it was live. Six granted RPCs were in that state.
 *
 *  A regex cannot do this: `"https://x"` contains a `//` that opens nothing,
 *  and so does the regex literal /\/\// (its 5th and 6th characters). So this
 *  walks the text and skips over string, template and regex literals rather
 *  than trying to recognise comments in isolation. */
function tsCode(text) {
  // A `/` starts a regex literal only where a value may begin. After a value
  // (identifier, number, `)`, `]`, string) it is division — and `<br />` in JSX
  // lands here too, which is why the check is on the preceding character.
  const VALUE_BEFORE = new Set(["", ...`=([{,;:!&|?+-*%~^<>`]);
  const KEYWORD_BEFORE =
    /(?:^|[^\w$])(?:return|typeof|case|in|of|new|delete|void|await|yield|do|else)$/;

  const n = text.length;
  let out = "";
  let i = 0;
  let prev = ""; // last non-whitespace character kept, in code mode
  let mode = "code";
  const tmplDepths = []; // brace depth at each open `${`, to find its close
  let depth = 0;

  while (i < n) {
    const c = text[i];
    const d = text[i + 1];

    if (mode === "tmpl") {
      if (c === "\\") {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        out += c;
        i += 1;
        mode = "code";
        prev = "`";
        continue;
      }
      if (c === "$" && d === "{") {
        out += "${";
        i += 2;
        tmplDepths.push(depth);
        depth += 1;
        mode = "code";
        prev = "{";
        continue;
      }
      out += c;
      i += 1;
      continue;
    }

    // `//` and `/*` are comments wherever they appear in code position — JS
    // itself resolves the ambiguity that way (`//` is never an empty regex).
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      j = Math.min(j + 1, n);
      out += text.slice(i, j);
      i = j;
      prev = c;
      continue;
    }
    if (c === "`") {
      out += c;
      i += 1;
      mode = "tmpl";
      continue;
    }
    if (c === "/" && (VALUE_BEFORE.has(prev) || KEYWORD_BEFORE.test(out.slice(-12)))) {
      // Regex literal, e.g. the one that strips a protocol separator. Its body
      // may contain escaped slashes that would otherwise read as a comment.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && text[j] !== "\n") {
        const ch = text[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        while (j < n && /[a-z]/.test(text[j])) j += 1; // flags
        out += text.slice(i, j);
        i = j;
        prev = "/";
        continue;
      }
      // Unterminated before the newline: it was division after all.
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (tmplDepths.length && depth === tmplDepths[tmplDepths.length - 1]) {
        tmplDepths.pop();
        out += c;
        i += 1;
        mode = "tmpl";
        prev = "}";
        continue;
      }
    }
    out += c;
    i += 1;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

// Read every file once. Rule 3 used to rebuild the whole SQL haystack inside
// its per-column loop.
let appTextCache = null;
let sqlTextCache = null;

/** Everything the app says, comments excluded, in one haystack. Callers use
 *  `.rpc("name")` but also build names dynamically in a couple of places, so a
 *  plain substring search is the conservative choice. */
function appText() {
  appTextCache ??= appSources()
    .map((f) => tsCode(readFileSync(f, "utf8")))
    .join("\n");
  return appTextCache;
}

function sqlText() {
  sqlTextCache ??= migrationFiles()
    .map((f) => sqlCode(readFileSync(f, "utf8")))
    .join("\n");
  return sqlTextCache;
}

// ── rule 1: RPCs granted to the app that nothing calls ─────────────────────

function checkUncalledRpcs(baseline) {
  const defined = new Map(); // name -> { file, returnsTrigger }
  const grantedToApp = new Set();

  for (const file of migrationFiles()) {
    const code = sqlCode(readFileSync(file, "utf8"));

    const defRe =
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*RETURNS\s+([a-z ]+)/gi;
    let m;
    while ((m = defRe.exec(code))) {
      defined.set(m[1], {
        file: relative(ROOT, file),
        // A trigger function is invoked by the trigger, never by name from the
        // app. Flagging those would be pure noise.
        returnsTrigger: /trigger/i.test(m[3]),
      });
    }

    const grantRe =
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.([a-z0-9_]+)[\s\S]{0,400}?TO\s+([^;]+);/gi;
    while ((m = grantRe.exec(code))) {
      if (/\b(authenticated|service_role)\b/i.test(m[2])) grantedToApp.add(m[1]);
    }
  }

  // SQL calls SQL constantly — PERFORM f(), SELECT f(), a DEFAULT, a trigger
  // body. A function called only from other SQL is alive.
  const app = appText();
  const sql = sqlText();

  const dead = [];
  for (const name of grantedToApp) {
    const def = defined.get(name);
    if (def?.returnsTrigger) continue;
    if (baseline.uncalled_rpcs?.[name]) continue;
    if (app.includes(name)) continue;

    // Called from SQL other than its own DDL? The old test listed the keywords
    // a call may follow — PERFORM|SELECT|JOIN|FROM|=|,|( — and that list was
    // missing this codebase's most common form:
    //
    //     IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION …
    //
    // which is how every SECURITY DEFINER function here authorises itself (see
    // 20260701185343:60 and :75, 20260717210000:53, 20260716210000:196). A
    // guard function used only that way would have been reported dead and the
    // only way to green would have been a baseline entry that was a lie.
    //
    // Enumerating keywords is the bug, not the specific omissions: the next
    // idiom (RETURN, WHERE, CASE, a CTE, EXECUTE FUNCTION) breaks it again. So
    // remove the DDL that names the function — its own definitions, grants,
    // comments, drops and alters — and treat any remaining `name(` as a call.
    const ddl = [
      `(?:CREATE|DROP|ALTER)\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?public\\.${name}\\s*\\(`,
      `(?:GRANT|REVOKE)[^;]*?public\\.${name}[^;]*;`,
    ];
    let withoutOwnDdl = sql;
    for (const pattern of ddl) {
      withoutOwnDdl = withoutOwnDdl.replace(new RegExp(pattern, "gi"), "");
    }
    // The lookbehind keeps `other_thing.name(` and `prefix_name(` from counting.
    const callish = new RegExp(`(?<![a-z0-9_.])(?:public\\.)?${name}\\s*\\(`, "i");
    if (callish.test(withoutOwnDdl)) continue;

    dead.push({
      kind: "rpc",
      name,
      where: def?.file ?? "(granted but not defined in the repo)",
      why: "granted to the app and called from neither TypeScript nor SQL",
    });
  }
  return dead.sort((a, b) => a.name.localeCompare(b.name));
}

// ── rule 2: endpoints nothing invokes ──────────────────────────────────────
//
// An API route under a hooks/ or queue/ path is by definition called from
// OUTSIDE the app — pg_cron, Stripe, Twilio, Supabase auth. Nothing inside the
// repo references it, so "no importer" proves nothing and the compiler is
// blind to it. The only way to know it is wired is to declare who calls it.
//
// WHAT THIS RULE DOES NOT DO, stated plainly because it is easy to assume
// otherwise: it checks that a declaration EXISTS, never that the caller does.
// "pg_cron job 'monthly-statements', 0 5 1 * * — verified in cron.job." with no
// such job passes. The declaration is a human attestation; the check only makes
// sure someone had to write one down and sign it.
//
// It stays that way on purpose. Verifying for real means querying cron.job,
// which CI does not have credentials for — and a rule that verifies only when
// credentials happen to be present is worse than this one, because it would
// pass silently in exactly the environment everyone trusts while looking like
// it checked. Verifying against the repo instead does not work either: of the
// three pg_cron jobs declared below, only 'weekly-digest' is created by a
// migration; 'nightly-automation' and 'process-email-queue' exist only in the
// database, so a repo-side check would flag two live jobs and still miss an
// invented name, which is the case it was supposed to catch.
//
// All three were confirmed present and active in cron.job on 2026-07-31.

function checkUninvokedEndpoints(baseline) {
  const routeDirs = [join(SRC, "routes", "api", "public"), join(SRC, "routes", "email")].filter(
    existsSync,
  );

  const endpoints = routeDirs
    .flatMap((d) => walk(d, (f) => /\.tsx?$/.test(f)))
    // Only files that actually serve a request. This used to be every .ts(x)
    // under those directories, so adding a shared helper —
    // hooks/_verify.ts, a schema module, a fixture — would fail CI demanding a
    // pg_cron job name for a file no scheduler could ever call, and the only
    // way to green would be a baseline entry describing a caller that cannot
    // exist. An endpoint here is a TanStack file route with a server handler.
    .filter((f) => {
      const code = tsCode(readFileSync(f, "utf8"));
      return /createFileRoute\s*\(/.test(code) && /\bhandlers\s*:/.test(code);
    })
    .map((f) => relative(ROOT, f))
    // Preview/debug routes are opened by a human with a browser; there is no
    // scheduler to declare and never will be.
    .filter((f) => !/preview\.tsx?$/.test(f));

  const declared = baseline.endpoint_callers ?? {};
  return endpoints
    .filter((f) => !declared[f])
    .map((f) => ({
      kind: "endpoint",
      name: f,
      where: f,
      why: "no caller declared — add it to endpoint_callers with what invokes it (a pg_cron job name, a provider webhook, or 'manual')",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── rule 3: columns written but never read ─────────────────────────────────
//
// The BUG-24 shape. `franchise_share_cents` was written on every adjustment and
// read by nothing, and it turned out to be the missing term in the settlement
// formula — locations were billed for refunds they had already paid. A column
// with a writer and no reader is a fact the system records and then ignores,
// which is either dead weight or a bug waiting to be found.
//
// Conservative by construction: only columns this repo's own migrations both
// DECLARE and write are considered, and any mention left anywhere else — SQL or
// src/ — counts as a read.
//
// HOW THIS RULE WAS WRONG, because the shape of the mistake matters more than
// the fix: it asked "does the column appear within 200 characters after a
// SELECT / WHERE / ON / AND / OR / comma?" — and in SQL that is always true.
// franchise_share_cents, the column this rule was written for, was classified
// as read because two lines above its own declaration in CREATE TABLE
// franchise_adjustments there is an `ON DELETE SET NULL,`. All 187 candidate
// columns passed, including with src/ removed from the search entirely. The
// rule could not fire. That is the worst kind of check: green by construction,
// and trusted.
//
// So the question is inverted. Instead of hunting for evidence of a read, blank
// out every occurrence that is a DECLARATION or a WRITE — the CREATE TABLE
// item, ADD COLUMN, the INSERT column list, the left side of an UPDATE … SET —
// and treat anything still standing as a read. A column's own name inside its
// own declaration is blanked too, because `CHECK (amount_cents >= 0)` is a
// constraint on the value, not a consumer of it.

/** Offset of the `)` matching the `(` at `open`, skipping quoted strings. */
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'") {
      i += 1;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 1;
          } else break;
        }
        i += 1;
      }
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** End of the current comma-separated item starting at `from`: the offset of
 *  the next `,` or `;` at paren depth 0, or of a clause keyword that ends an
 *  assignment list. */
function endOfItem(text, from, limit = text.length, clauseKeywords = null) {
  let depth = 0;
  for (let i = from; i < limit; i += 1) {
    const c = text[i];
    if (c === "'") {
      i += 1;
      while (i < limit) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 1;
          } else break;
        }
        i += 1;
      }
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && (c === "," || c === ";")) return i;
    else if (
      depth === 0 &&
      clauseKeywords &&
      /[a-z]/i.test(c) &&
      !/[a-z0-9_.]/i.test(text[i - 1] ?? " ")
    ) {
      const word = /^[a-z]+/i.exec(text.slice(i, i + 12))?.[0] ?? "";
      if (clauseKeywords.has(word.toUpperCase())) return i;
    }
  }
  return limit;
}

const TABLE_CONSTRAINT_WORDS = new Set([
  "constraint",
  "primary",
  "foreign",
  "unique",
  "check",
  "exclude",
  "like",
  "deferrable",
]);
const ASSIGNMENT_END_WORDS = new Set(["WHERE", "FROM", "RETURNING"]);

/** Column names this file declares and writes, plus the same SQL with every
 *  declaration and write target blanked out so what remains is only reads. */
function columnWritesAndReads(code) {
  const writes = new Set();
  const declared = new Set();
  const chars = code.split("");
  const blank = (start, end) => {
    for (let i = start; i < end; i += 1) if (!/\s/.test(chars[i])) chars[i] = " ";
  };
  const blankName = (name, start, end) => {
    const re = new RegExp(`\\b${name}\\b`, "gi");
    const seg = code.slice(start, end);
    let m;
    while ((m = re.exec(seg))) blank(start + m.index, start + m.index + m[0].length);
  };

  let m;

  // CREATE TABLE t (col type …, CONSTRAINT …) — declarations, not reads.
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-z0-9_."]+\s*\(/gi;
  while ((m = tableRe.exec(code))) {
    const open = tableRe.lastIndex - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    let at = open + 1;
    while (at < close) {
      const end = endOfItem(code, at, close);
      const item = code.slice(at, end);
      const decl = /^\s*([a-z_][a-z0-9_]*)\s+\S/i.exec(item);
      const col = decl?.[1].toLowerCase();
      if (col && !TABLE_CONSTRAINT_WORDS.has(col)) {
        declared.add(col);
        blankName(col, at, end);
      }
      at = end + 1;
    }
    tableRe.lastIndex = close;
  }

  // ALTER TABLE … ADD COLUMN col type CHECK (col …) — the inline CHECK names
  // the column it constrains, which is why the whole item is blanked, not just
  // the identifier after ADD COLUMN.
  const addRe = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
  while ((m = addRe.exec(code))) {
    declared.add(m[1].toLowerCase());
    blankName(m[1].toLowerCase(), m.index, endOfItem(code, addRe.lastIndex));
  }
  const otherDdlRe = /\b(?:DROP|RENAME|ALTER)\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
  while ((m = otherDdlRe.exec(code))) {
    blank(otherDdlRe.lastIndex - m[1].length, otherDdlRe.lastIndex);
  }

  // INSERT INTO t (a, b, c) — a write of every column named.
  const insertRe = /INSERT\s+INTO\s+[a-z0-9_."]+\s*\(/gi;
  while ((m = insertRe.exec(code))) {
    const open = insertRe.lastIndex - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    const items = code
      .slice(open + 1, close)
      .split(",")
      .map((s) => s.trim().toLowerCase());
    // `INSERT INTO t SELECT …` has no list; anything not a bare identifier
    // means this is not one.
    if (items.every((s) => /^[a-z_][a-z0-9_]*$/.test(s))) {
      for (const col of items) writes.add(col);
      blank(open + 1, close);
      insertRe.lastIndex = close;
    }
  }

  // UPDATE t SET a = …, b = … / ON CONFLICT … DO UPDATE SET …
  //
  // Anchored on UPDATE on purpose. A bare /SET\s+(\w+)\s*=/ also matches the
  // `SET search_path = public` on every SECURITY DEFINER function, which is a
  // session setting, not a column, and used to be reported as a written column.
  const updateRe = /\b(?:UPDATE\s+(?:ONLY\s+)?[a-z0-9_."]+|DO\s+UPDATE)\s+SET\s+/gi;
  while ((m = updateRe.exec(code))) {
    let at = updateRe.lastIndex;
    for (;;) {
      const target = /^\s*([a-z_][a-z0-9_]*)\s*=(?!>)/i.exec(code.slice(at, at + 200));
      if (!target) break;
      const nameAt = at + target[0].indexOf(target[1]);
      writes.add(target[1].toLowerCase());
      blank(nameAt, nameAt + target[1].length);
      const end = endOfItem(code, at + target[0].length, code.length, ASSIGNMENT_END_WORDS);
      if (code[end] !== ",") break;
      at = end + 1;
    }
  }

  return { writes, declared, reads: chars.join("") };
}

function checkWriteOnlyColumns(baseline) {
  const written = new Map(); // column -> file it was written in
  const declaredHere = new Set();
  const readable = [];

  for (const file of migrationFiles()) {
    const { writes, declared, reads } = columnWritesAndReads(sqlCode(readFileSync(file, "utf8")));
    for (const col of writes) if (!written.has(col)) written.set(col, relative(ROOT, file));
    for (const col of declared) declaredHere.add(col);
    readable.push(reads);
  }
  // src/ counts as a read surface, comments excluded — see tsCode().
  readable.push(appText());
  const readText = readable.join("\n");

  const dead = [];
  for (const [col, file] of written) {
    if (baseline.write_only_columns?.[col]) continue;
    // Too generic to reason about — `id`, `status`, `name` appear everywhere.
    if (col.length < 8) continue;
    // Judge only columns this repo also DECLARES. Migrations are a historical
    // record, not a picture of the schema: `route_order` is written by one 2026-07-02
    // migration, is declared by none, and does not exist in the database at all —
    // both the column and that version of the function were superseded. If the
    // repo cannot see where a column comes from, it cannot see all of its
    // readers either, and the rule has no standing to call it dead.
    if (!declaredHere.has(col)) continue;
    if (new RegExp(`\\b${col}\\b`, "i").test(readText)) continue;

    dead.push({
      kind: "column",
      name: col,
      where: file,
      why: "written by a migration and read by nothing — either dead weight or a missing term somewhere (see BUG-24)",
    });
  }
  return dead.sort((a, b) => a.name.localeCompare(b.name));
}

// ── report ─────────────────────────────────────────────────────────────────

function main() {
  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};

  const findings = [
    ...checkUncalledRpcs(baseline),
    ...checkUninvokedEndpoints(baseline),
    ...checkWriteOnlyColumns(baseline),
  ];

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(findings, null, 2));
    process.exit(findings.length ? 1 : 0);
  }

  // A baseline entry is either "verified fine" or "KNOWN GAP". The second kind
  // is real debt, and writing it down must not be the same as dealing with it —
  // so it is counted and named on EVERY run, green or not. A check that lets
  // unfinished work disappear the moment it is recorded is the mute button this
  // file's own header warns against.
  const groups = [
    ["uncalled_rpcs", "RPC"],
    ["endpoint_callers", "endpoint"],
    ["write_only_columns", "column"],
  ];
  const gaps = [];
  let exceptions = 0;
  for (const [key, label] of groups) {
    for (const [name, reason] of Object.entries(baseline[key] ?? {})) {
      exceptions += 1;
      if (String(reason).startsWith("KNOWN GAP")) gaps.push({ label, name, reason });
    }
  }

  const reportGaps = () => {
    if (!gaps.length) return;
    console.log(`\n  ${gaps.length} known gap(s) — built, still not wired to anything:`);
    for (const g of gaps) {
      console.log(`    [${g.label}] ${g.name}`);
      console.log(`        ${g.reason.replace(/^KNOWN GAP — /, "")}`);
    }
    console.log(
      "\n  These are recorded, not resolved. Clear one by wiring it up — editing\n" +
        "  its reason only makes the debt harder to find.",
    );
  };

  if (findings.length === 0) {
    console.log(
      `✓ nothing newly built-and-unwired — ${exceptions} exception(s) in the baseline, each with a reason.`,
    );
    reportGaps();
    return;
  }

  console.error(`✗ ${findings.length} thing(s) exist but nothing appears to use them:\n`);
  for (const f of findings) {
    console.error(`    [${f.kind}] ${f.name}`);
    console.error(`        in: ${f.where}`);
    console.error(`        ${f.why}\n`);
  }
  console.error(
    "Each of these is either a wiring bug or a deliberate exception.\n" +
      "If it is a BUG, wire it up — that is the point of this check.\n" +
      "If it is DELIBERATE, add it to scripts/dead-machinery-baseline.json with a\n" +
      "reason someone can evaluate later. Never add an entry just to silence this;\n" +
      "the baseline is a record of decisions, not a mute button.",
  );
  reportGaps();
  process.exit(1);
}

main();
