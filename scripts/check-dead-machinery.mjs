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
// Rule 4 proved the point on its first run: it reported five overload sets and
// every one was its own type normalizer reading `public.addon_frequency` and
// `addon_frequency` as different types. Zero were real. A new rule's first
// output is evidence about the rule, not about the codebase.
//
// EVERY RULE HERE IS MUTATION-TESTED, because a check nobody has seen fail is
// a check nobody has evidence about. Each is proven to flag the case it was
// written for, and to go green again when that case is removed.
//
// Usage:
//   node scripts/check-dead-machinery.mjs
//   node scripts/check-dead-machinery.mjs --json      (machine-readable)

import { toPosix } from "./posix-path.mjs";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

/** Per-file source, for rules that need to know WHICH file said something.
 *  appText() flattens everything into one haystack and so cannot answer
 *  "does any file other than the definer mention this name". */
let appFilesCache = null;
function appFiles() {
  appFilesCache ??= appSources().map((f) => [f, readFileSync(f, "utf8")]);
  return appFilesCache;
}

let codeFilesCache = null;

/** appFiles(), comment-stripped once.
 *
 *  `tsCode()` walks its input character by character to skip string, template
 *  and regex literals, so it is not cheap. Rule 5 asks "does any other file
 *  mention this name" once per server function, and there are ~200 of those
 *  against ~490 files: calling tsCode() inside that loop is ~100k parses of the
 *  same text. It cost 90 seconds when rule 5 stopped short-circuiting on the
 *  first match (it now needs every mention, to tell "mentioned nowhere" from
 *  "mentioned only by dead files"). Strip each file once instead. */
function codeFiles() {
  codeFilesCache ??= appFiles().map(([path, text]) => [path, tsCode(text)]);
  return codeFilesCache;
}

// ── module reachability ────────────────────────────────────────────────────
//
// Which files the shipped app can actually run. Rules 5 and 6 both need it:
// "nothing imports this" is only meaningful if the things doing the importing
// are themselves reachable.
//
// Vendored code is exempt. `components/ui/**` is the shadcn scaffold — it
// arrives as a full component library and most apps use a third of it, so
// reporting the unused two thirds would be twenty findings nobody authored and
// nobody will act on. That is the noise this file's header warns about, not a
// gap. Same for the Lovable integration shim.
const UNREACHABLE_EXEMPT = [/\/src\/components\/ui\//, /\/src\/integrations\/lovable\//];

/** `@/x`, `./x` and `../x` resolved to a real file, or null for a package. */
function resolveImport(spec, fromFile, known) {
  let base;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // node_modules — not ours to trace
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    base,
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

let reachableCache = null;

/**
 * Files reachable from an entry point, as a Set of absolute paths.
 *
 * Roots are every file under `src/routes` — in file-based routing each one IS
 * an entry point, mounted by the generated route tree — plus the four
 * top-level bootstraps. Edges come from static `from "..."` and dynamic
 * `import("...")` alike, since this codebase uses lazy imports freely for
 * server-only modules.
 *
 * Read from comment-stripped source: a comment naming a module is not an
 * import, and mistaking one for the other is how `LanguageToggle` looked alive
 * for months on the strength of a line reading "// LanguageToggle moved to
 * Settings → Preferences" — a comment that was true about the feature and false
 * about the component, which had been left behind.
 */
function reachableAppFiles() {
  if (reachableCache) return reachableCache;

  const known = new Set(appSources());
  const edges = new Map();
  for (const [path, code] of codeFiles()) {
    const out = new Set();
    for (const m of code.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)) {
      const target = resolveImport(m[1], path, known);
      if (target) out.add(target);
    }
    edges.set(path, out);
  }

  const isRoot = (f) =>
    f.startsWith(join(SRC, "routes")) || /\/(router|server|start|routeTree\.gen)\.(ts|tsx)$/.test(f);
  const seen = new Set([...known].filter(isRoot));
  const queue = [...seen];
  while (queue.length) {
    for (const next of edges.get(queue.pop()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  reachableCache = seen;
  return seen;
}

function sqlText() {
  sqlTextCache ??= migrationFiles()
    .map((f) => sqlCode(readFileSync(f, "utf8")))
    .join("\n");
  return sqlTextCache;
}

// ── rule 1: RPCs granted to the app that nothing calls ─────────────────────

/**
 * Type names as Postgres would compare them, not as they happen to be typed.
 *
 * This exists because the first version of the overload rule reported five
 * findings and all five were wrong — it had read `public.addon_frequency` and
 * `addon_frequency` as two different types, and `int` and `integer` likewise.
 * The rule was measuring its own parser. Everything below is one of those five.
 */
const TYPE_ALIASES = new Map([
  ["int", "integer"],
  ["int4", "integer"],
  ["int2", "smallint"],
  ["int8", "bigint"],
  ["bool", "boolean"],
  ["float8", "double precision"],
  ["float4", "real"],
  ["varchar", "character varying"],
  ["timestamptz", "timestamp with time zone"],
  ["timetz", "time with time zone"],
  ["decimal", "numeric"],
]);

function canonicalType(t) {
  // A DROP writes `addon_frequency`; the CREATE that made it writes
  // `public.addon_frequency`. Same type, and every type here is in public or
  // pg_catalog, so the qualifier carries no information.
  const bare = t.replace(/^(?:public|pg_catalog)\./i, "").toLowerCase();
  return TYPE_ALIASES.get(bare) ?? bare;
}

/**
 * The argument list of a CREATE or DROP, reduced to a comparable type list.
 *
 * `_visit_id uuid, _reason text, _code skip_reason_code DEFAULT 'other'`
 * and `uuid, text, skip_reason_code` must come out the same, because the first
 * is how a function is declared and the second is how it is dropped.
 *
 * Returns null when it cannot be confident — nested parentheses in a DEFAULT,
 * an array or quoted type, anything unexpected. Callers treat null as "no
 * signature information", which falls back to the older name-only behaviour.
 * A wrong match here would exempt a live function from the check or fail CI on
 * a correct one, so declining to answer has to be a first-class outcome. On
 * this tree it declines for 8 of 300 declarations (array types, a jsonb
 * default) — and it declines identically on the CREATE and the DROP, so those
 * still pair up.
 */
function argTypes(raw) {
  const s = (raw ?? "").trim();
  if (s === "") return "";
  if (/[()"[\]]/.test(s)) return null;
  return s
    .split(",")
    .map((part) => {
      let a = part.trim().replace(/\s+/g, " ");
      a = a.replace(/\s+DEFAULT\s+.*$/i, "");
      a = a.replace(/^(?:IN|OUT|INOUT|VARIADIC)\s+/i, "");
      const words = a.split(" ");
      // `name type` vs a bare `type`. A parameter name is always a plain
      // identifier, and every single-word type this schema uses is one word.
      if (words.length === 2) return canonicalType(words[1]);
      if (words.length === 1) return canonicalType(words[0]);
      return null;
    })
    .reduce((acc, t) => (acc === null || t === null ? null : [...acc, t]), [])
    ?.join(",");
}

let functionScanCache = null;

/** One pass over the migration tree, shared by rule 1 and rule 4 so the two
 *  cannot form different opinions about what exists. */
function scanFunctions() {
  if (functionScanCache) return functionScanCache;
  const defined = new Map(); // name -> { file, returnsTrigger }
  const grantedToApp = new Set();
  // A function this repo has since DROPPED. Migrations are an append-only
  // history, so the CREATE and the GRANT stay in the tree for ever — without
  // this, dropping a dead function leaves it looking dead for ever, and the
  // only way to green the check would be a baseline entry describing something
  // that no longer exists. Three drops on 2026-07-31 hit exactly that.
  //
  // Tracked in migration order, and a later CREATE un-drops it, so a
  // drop-and-recreate (the only way to change a function's signature) is not
  // mistaken for a removal.
  //
  // ── WHY THIS IS KEYED ON THE SIGNATURE AND NOT THE NAME ──────────────────
  //
  // It used to be a Set of names, and that was wrong in both directions.
  //
  // Postgres identifies a function by name AND argument types, so one name can
  // be two functions. skip_visit was: skip_visit(uuid, text) shipped on
  // 2026-07-01 and skip_visit(uuid, text, skip_reason_code) two days later.
  // The app moved to the three-argument form; the two-argument one stayed
  // granted to `authenticated` and reachable by nothing for a month. This rule
  // could not see it, because the live overload's callers vouched for the dead
  // one — not a rule that failed, a rule that could not ask the question.
  //
  // And dropping the dead one made it worse: a single `DROP FUNCTION
  // public.skip_visit(uuid, text)` marked the whole NAME dropped, so the live
  // three-argument function — granted, and the only way a tech skips a visit —
  // fell out of the check's coverage entirely. Verified by reproducing the
  // scan: `dropped.has("skip_visit")` came back true.
  //
  // So drops and creates are both tracked per signature. Where argTypes()
  // declines to parse, the entry degrades to the old name-only behaviour
  // rather than guessing.
  const droppedSigs = new Set(); // "name(uuid,text)" or "name" when unparsed
  const createdSigs = new Map(); // name -> Set of signature strings

  const sigKey = (name, types) => (types === null ? name : `${name}(${types})`);

  for (const file of migrationFiles()) {
    const code = sqlCode(readFileSync(file, "utf8"));

    const dropRe =
      /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?public\.([a-z0-9_]+)\s*(?:\(([^)]*)\))?/gi;
    let d;
    while ((d = dropRe.exec(code))) {
      // A DROP with no argument list is unambiguous only when the name has one
      // signature — but it is also how every pre-existing drop in this tree is
      // written, so treat it as dropping the name.
      droppedSigs.add(d[2] === undefined ? d[1] : sigKey(d[1], argTypes(d[2])));
    }

    const defRe =
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*RETURNS\s+([a-z ]+)/gi;
    let m;
    while ((m = defRe.exec(code))) {
      const key = sigKey(m[1], argTypes(m[2]));
      // Re-created after a drop: THIS signature is live again. A bare-name drop
      // is cleared too, since the name demonstrably exists once more.
      droppedSigs.delete(key);
      droppedSigs.delete(m[1]);
      if (!createdSigs.has(m[1])) createdSigs.set(m[1], new Set());
      createdSigs.get(m[1]).add(key);
      defined.set(m[1], {
        file: toPosix(relative(ROOT, file)),
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

  /** A name is gone only when every signature the repo created is dropped. */
  const dropped = {
    has(name) {
      if (droppedSigs.has(name)) return true;
      const sigs = createdSigs.get(name);
      if (!sigs || sigs.size === 0) return false;
      return [...sigs].every((s) => droppedSigs.has(s));
    },
  };

  functionScanCache = { defined, grantedToApp, dropped, createdSigs, droppedSigs };
  return functionScanCache;
}

// ── rule 1: RPCs granted to the app that nothing calls ─────────────────────

function checkUncalledRpcs(baseline) {
  const { defined, grantedToApp, dropped } = scanFunctions();

  // SQL calls SQL constantly — PERFORM f(), SELECT f(), a DEFAULT, a trigger
  // body. A function called only from other SQL is alive.
  const app = appText();
  const sql = sqlText();

  const dead = [];
  for (const name of grantedToApp) {
    if (dropped.has(name)) continue;
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
    .map((f) => toPosix(relative(ROOT, f)))
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
    for (const col of writes) if (!written.has(col)) written.set(col, toPosix(relative(ROOT, file)));
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

// ── rule 4: one name, two live functions ───────────────────────────────────
//
// This rule exists because the three above could not have found what it finds.
//
// skip_visit shipped twice: skip_visit(uuid, text) on 2026-07-01 and
// skip_visit(uuid, text, skip_reason_code) two days later. Postgres keeps both
// — a different argument list is a different function — and both were granted
// to `authenticated`. The app moved to the three-argument form immediately, so
// for a month there was a granted, reachable, never-called RPC sitting in the
// schema, running a body that predated the org skip-billing rules.
//
// Rule 1 is name-keyed and therefore blind to it: the live overload's callers
// vouch for the dead one. Rule 1 has to stay name-keyed, because a call site is
// `.rpc("skip_visit", { … })` — named arguments, no signature to match against.
// So the question gets asked here instead, and it is a different question:
// not "does anything call this" but "is there more than one of it".
//
// An overload is not automatically wrong. It is automatically UNEXAMINED, and
// the way it arises — add a parameter, ship, forget the old one is still there
// — means it is usually an accident. So it needs a line in the baseline saying
// which signatures are meant and why, and that line is cheap for a deliberate
// overload and awkward for an accidental one, which is the intent.
//
// The whole schema had exactly one overload set when this was written, and it
// was the accident. After the drop: zero. This rule starts green.

function checkUndeclaredOverloads(baseline) {
  const { createdSigs, droppedSigs, defined } = scanFunctions();
  const found = [];
  for (const [name, sigs] of createdSigs) {
    const live = [...sigs].filter((s) => !droppedSigs.has(s) && !droppedSigs.has(name));
    if (live.length < 2) continue;
    if (baseline.function_overloads?.[name]) continue;
    found.push({
      kind: "overload",
      name,
      where: defined.get(name)?.file ?? "(unknown)",
      why:
        `declared with ${live.length} different argument lists — ${live.join(", ")}. ` +
        `Postgres treats these as separate functions, and a caller that omits an ` +
        `argument silently reaches the older body. If both are meant, say so in ` +
        `the baseline; if one is left over, drop it.`,
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}


// ── Rule 5: a server function nothing imports ──────────────────────────────
//
// Added because this file MISSED a live instance of exactly what it is for.
//
// `recordSmsConsent`, `getSmsConsentCoverage` and `portalSetSmsConsent` shipped
// with the SMS-consent model. All three were exported, correct, tested at the
// SQL layer — and imported by nothing. The consent guard they were built to
// satisfy went live at the same time, so texting stopped working for every
// client and the only screen that could have fixed it did not exist.
//
// Rules 1-4 could not see it. They watch SQL→app, cron→endpoint and
// writer→reader, and the header says unused TypeScript is "already caught by
// the compiler". It is not: `tsc` does not flag an unused EXPORT, and neither
// does the bundler, because an export is a public API by definition. A server
// function wired to no UI falls precisely between the two.
//
// A `createServerFn` export counts as dead when no REACHABLE file mentions it.
//
// The original version asked only "does any other file mention this", and said
// so knowingly: "That will miss a function whose only caller is itself dead,
// and that is the right trade: false positives here would train people to
// ignore the check."
//
// The miss turned out to be real. `WeatherStrip.tsx` — 220 lines, finished,
// with a bulk weather-reschedule flow — was never rendered anywhere. It was the
// only importer of `analyzeDayWeather`, `rescheduleVisits` and
// `undoReschedule`, so all three read as WIRED to this check while being
// reachable from nothing. One dead file was vouching for three dead functions.
//
// The predicted cost of fixing it — false positives — did not materialise,
// because reachability is not a guess in a file-based-routing app: every screen
// is a file under src/routes, so the reachable set is exactly what
// moduleGraph() reaches from there. Measured when this changed: 23 of 487 files
// unreachable, 20 of them unused shadcn/ui primitives that ship with the
// scaffold (excluded as vendored, see UNREACHABLE_EXEMPT), and the three that
// remained were all genuine.
//
// Still conservative in the way that matters: one mention from one reachable
// file vouches for a function. This does not try to prove the mention is a
// call.
function checkUnwiredServerFns(baseline) {
  const files = codeFiles();
  const reachable = reachableAppFiles();
  const dead = [];

  for (const [path, code] of files) {
    // `path` is absolute and built with join(), so on Windows this was false
    // for every file: the rule skipped the lot and reported nothing wrong.
    // A check that passes by never looking is worse than one that fails.
    if (!toPosix(path).includes("/lib/")) continue;
    // `export const NAME = createServerFn(` — the entry-point form. A plain
    // exported helper is ordinary TypeScript and out of scope.
    for (const m of code.matchAll(/export\s+const\s+(\w+)\s*=\s*createServerFn\b/g)) {
      const name = m[1];
      if (baseline.unwired_server_fns?.[name]) continue;
      const mentions = files.filter(
        ([other, otherCode]) => other !== path && otherCode.includes(name),
      );
      if (mentions.length === 0) {
        dead.push({
          kind: "server fn",
          name,
          where: path.replace(/^.*\/src\//, "src/"),
          why: "exported createServerFn that no other file mentions — no UI can reach it",
        });
        continue;
      }
      // Mentioned, but only by files that are themselves unreachable. Naming
      // them matters: the fix is usually to the importer, not to this function.
      if (!mentions.some(([other]) => reachable.has(other))) {
        const via = mentions.map(([o]) => o.replace(/^.*\/src\//, "src/")).join(", ");
        dead.push({
          kind: "server fn",
          name,
          where: path.replace(/^.*\/src\//, "src/"),
          why: `only mentioned by unreachable file(s) — ${via} — so no UI can reach it either`,
        });
      }
    }
  }
  return dead.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Rule 6: a module nothing reachable imports ─────────────────────────────
//
// The root cause behind rule 5's blind spot, reported in its own right so the
// fix lands on the importer rather than on whatever it happened to import.
//
// `tsc` will not catch this either: an unimported module is not an error, it is
// simply never bundled. It compiles, its tests pass, and it does nothing.
function checkUnreachableModules(baseline) {
  const reachable = reachableAppFiles();
  return appSources()
    .filter((f) => !reachable.has(f))
    .filter((f) => !UNREACHABLE_EXEMPT.some((re) => re.test(f)))
    .map((f) => f.replace(/^.*\/src\//, "src/"))
    .filter((rel) => !baseline.unreachable_modules?.[rel])
    .map((rel) => ({
      kind: "module",
      name: rel,
      where: rel,
      why: "no file reachable from src/routes imports this — it is compiled, never bundled, and runs nowhere",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── report ─────────────────────────────────────────────────────────────────

function main() {
  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};

  const findings = [
    ...checkUncalledRpcs(baseline),
    ...checkUninvokedEndpoints(baseline),
    ...checkWriteOnlyColumns(baseline),
    ...checkUndeclaredOverloads(baseline),
    ...checkUnwiredServerFns(baseline),
    ...checkUnreachableModules(baseline),
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
    ["function_overloads", "overload"],
    ["unwired_server_fns", "server fn"],
    ["unreachable_modules", "module"],
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
