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
 *  comment. */
function sqlCode(text) {
  return text.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
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

    const grantRe = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.([a-z0-9_]+)[\s\S]{0,400}?TO\s+([^;]+);/gi;
    while ((m = grantRe.exec(code))) {
      if (/\b(authenticated|service_role)\b/i.test(m[2])) grantedToApp.add(m[1]);
    }
  }

  // Everything the app says, in one haystack. Callers use `.rpc("name")`, but
  // also build names dynamically in a couple of places, so a plain substring
  // search is the conservative choice.
  const appText = appSources()
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  // SQL calls SQL constantly — PERFORM f(), SELECT f(), a DEFAULT, a trigger
  // body. A function called only from other SQL is alive.
  const sqlText = migrationFiles()
    .map((f) => sqlCode(readFileSync(f, "utf8")))
    .join("\n");

  const dead = [];
  for (const name of grantedToApp) {
    const def = defined.get(name);
    if (def?.returnsTrigger) continue;
    if (baseline.uncalled_rpcs?.[name]) continue;
    if (appText.includes(name)) continue;

    // Called from SQL other than its own definition? Count occurrences that
    // are not the CREATE/GRANT/COMMENT lines.
    const callish = new RegExp(
      `(?:PERFORM|SELECT|JOIN|FROM|=|,|\\()\\s*(?:public\\.)?${name}\\s*\\(`,
      "i",
    );
    const withoutOwnDefs = sqlText
      .replace(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, "gi"), "")
      .replace(new RegExp(`(?:GRANT|REVOKE)[^;]*?public\\.${name}[^;]*;`, "gi"), "")
      .replace(new RegExp(`COMMENT\\s+ON\\s+FUNCTION\\s+public\\.${name}[^;]*;`, "gi"), "");
    if (callish.test(withoutOwnDefs)) continue;

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

function checkUninvokedEndpoints(baseline) {
  const routeDirs = [
    join(SRC, "routes", "api", "public"),
    join(SRC, "routes", "email"),
  ].filter(existsSync);

  const endpoints = routeDirs
    .flatMap((d) => walk(d, (f) => /\.tsx?$/.test(f)))
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
// Conservative by construction: only columns this repo's own migrations INSERT
// or UPDATE are considered, and any mention anywhere else counts as a read.

function checkWriteOnlyColumns(baseline) {
  const written = new Map(); // column -> file it was written in

  for (const file of migrationFiles()) {
    const code = sqlCode(readFileSync(file, "utf8"));

    // UPDATE ... SET col = ...
    const setRe = /\bSET\s+([a-z0-9_]+)\s*=/gi;
    let m;
    while ((m = setRe.exec(code))) {
      if (!written.has(m[1])) written.set(m[1], relative(ROOT, file));
    }
    // INSERT INTO t (a, b, c)
    const insRe = /INSERT\s+INTO\s+[a-z0-9_.]+\s*\(([^)]*)\)/gi;
    while ((m = insRe.exec(code))) {
      for (const raw of m[1].split(",")) {
        const col = raw.trim().toLowerCase();
        if (/^[a-z0-9_]+$/.test(col) && !written.has(col)) {
          written.set(col, relative(ROOT, file));
        }
      }
    }
  }

  const appText = appSources()
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  const dead = [];
  for (const [col, file] of written) {
    if (baseline.write_only_columns?.[col]) continue;
    // Too generic to reason about — `id`, `status`, `name` appear everywhere.
    if (col.length < 8) continue;
    if (appText.includes(col)) continue;

    // Read anywhere in SQL? A SELECT list, a WHERE, a RETURNING, an expression.
    const sqlText = migrationFiles()
      .map((f) => sqlCode(readFileSync(f, "utf8")))
      .join("\n");
    const readish = new RegExp(
      `(?:SELECT|WHERE|RETURNING|ORDER\\s+BY|GROUP\\s+BY|ON|AND|OR|coalesce\\(|sum\\(|,)[^;]{0,200}?\\b${col}\\b(?!\\s*=)`,
      "i",
    );
    if (readish.test(sqlText)) continue;

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
  const baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
    : {};

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
