#!/usr/bin/env node
// IMP-2b — verify the migration baseline OBJECT by object, not file by file.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// `check-migrations.mjs` answers "is every migration file accounted for in the
// database's ledger?". For 82 files it cannot answer that by name, because they
// were applied under different names — so `migrations-baseline.json` exempts
// them, and its comment says each was "verified individually by checking that
// the objects they create exist".
//
// That claim was not true, and the check had no way to notice.
// `public.seed_demo_org(uuid)` is defined in TWO baselined files
// (20260703043929 and 20260703051513) and existed in NEITHER copy of the live
// database. The app called it by name for a month and got PGRST202 every time.
//
// The reason a file-level exemption cannot catch this: 20260703051513 defines
// six functions. Five landed. `seed_demo_org` did not. "Was this file applied?"
// has no answer that distinguishes those two cases, so the honest answer —
// "mostly" — gets recorded as a pass.
//
// So this check does not ask about files. It asks about every object the repo's
// migrations claim to create, and whether it is in the catalog now.
//
// ── THE PART THAT MAKES IT USABLE RATHER THAN NOISE ───────────────────────
//
// A naive "everything ever created must exist" check is wrong on its face: this
// repo deliberately drops things. `org_ai_credentials` was dropped in IMP-9,
// `portal_get_client` was replaced by a differently-signed version, columns get
// renamed. Reporting those as missing schema produces exactly the eighty false
// positives that made the original name-comparison unusable — and §4 of the
// brief is explicit that a check which cries wolf is worse than no check.
//
// So the expected state is REPLAYED: migrations are read in filename order and
// each CREATE adds to the expected set while each DROP removes from it. What is
// verified is the set that survives to the end. An object created in March and
// dropped in June is expected to be absent, and its absence is not a finding.
//
// ── WHAT IS AND IS NOT COVERED ────────────────────────────────────────────
//
// Covered: functions, tables, columns, enum types. Those are what application
// code binds to by name — a missing one is a runtime error in front of a user,
// which is the failure this whole check exists to prevent.
//
// NOT covered: policies, triggers, indexes, grants. Not because they do not
// matter, but because their names are frequently rewritten in place by later
// migrations and a replay of their lifecycle is guesswork. RLS coverage is
// already asserted directly (`0 tables without RLS`) and permission parity has
// its own test. Saying so here is the point: a check that quietly covers less
// than its name implies is how "verified" came to mean "assumed" the first time.
//
// Usage:
//   SUPABASE_DB_URL=postgres://... node scripts/check-baseline-objects.mjs
//   node scripts/check-baseline-objects.mjs --catalog-from catalog.json
//
// The offline form takes the JSON produced by the query in `CATALOG_SQL` below,
// for running against a database this sandbox can only reach over MCP.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

/** The catalog snapshot this check compares against. Kept here rather than in a
 *  separate file so the offline form and the psql form cannot drift apart. */
export const CATALOG_SQL = `
select json_build_object(
  'functions', (select coalesce(json_agg(distinct p.proname), '[]'::json)
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public'),
  'tables',    (select coalesce(json_agg(distinct c.relname), '[]'::json)
                  from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind in ('r','v','m','p')),
  'columns',   (select coalesce(json_agg(distinct (c.table_name || '.' || c.column_name)), '[]'::json)
                  from information_schema.columns c
                 where c.table_schema = 'public'),
  'types',     (select coalesce(json_agg(distinct t.typname), '[]'::json)
                  from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typtype = 'e')
) as catalog;
`;

/**
 * Reduce SQL to executable code: comments and string literals removed.
 *
 * Both halves are load-bearing, and each was found by a false positive rather
 * than by foresight:
 *
 *   * Comments — a `-- DROP TABLE x` in a note must not remove x from the
 *     expected set, and a commented-out CREATE must not add one.
 *   * String literals — the first run of this check reported a missing table
 *     named `as`, from `command_tag IN ('CREATE TABLE', 'CREATE TABLE AS')`
 *     inside an event-trigger body. One bogus finding is all it takes for a
 *     check to start getting waved through, which is the failure mode §4 of
 *     the brief is about.
 *
 * Done as a scanner rather than three chained `.replace()` calls because the
 * orders contradict: strip comments first and an apostrophe inside one breaks
 * literal matching; strip literals first and a quote inside a comment does the
 * same. A single pass has no ordering to get wrong.
 *
 * Dollar-quoted bodies are NOT removed. A migration that wraps DDL in
 * `DO $$ ... $$` still creates the object, and dropping those regions would
 * silently narrow what this check covers — the exact shape of the problem it
 * exists to fix.
 */
export function sqlCode(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2; // '' is an escaped quote, not the end
          else { i++; break; }
        } else i++;
      }
      out += " "; // a literal becomes whitespace, never a joined-up token
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

const unquote = (s) => s.replace(/"/g, "").trim().toLowerCase();
/** `public.foo` and `foo` are the same object; migrations write both. */
const bare = (s) => unquote(s).replace(/^public\./, "");

/**
 * Replay every migration in order, building the set of objects expected to
 * exist at the end.
 *
 * Returns Maps from object key -> the file that last created it, so a finding
 * can name the migration to look at rather than just the missing name.
 */
export function expectedObjects(files) {
  const functions = new Map();
  const tables = new Map();
  const columns = new Map();
  const types = new Map();

  // Statements are applied in DOCUMENT ORDER, not grouped by kind.
  //
  // The first version of this ran every CREATE in a file and then every DROP,
  // and `20260703051513` opens with
  //     DROP FUNCTION IF EXISTS public.portal_get_client(uuid);
  //     CREATE OR REPLACE FUNCTION public.portal_get_client(_token uuid) ...
  // — the ordinary way to change a function's signature. Grouping made the DROP
  // win, so four portal functions that exist and are called every day fell out
  // of the expected set. The check passed having looked at less than it
  // claimed, which is the same shape as the bug it was written to catch.
  const EVENTS = [
    [/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z0-9_."]+)\s*\(/gi,
      (m, name) => functions.set(bare(m[1]), name)],
    [/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_."]+)/gi,
      (m, name) => tables.set(bare(m[1]), name)],
    [/CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_."]+)/gi,
      (m, name) => tables.set(bare(m[1]), name)],
    [/CREATE\s+TYPE\s+([a-z0-9_."]+)\s+AS\s+ENUM/gi,
      (m, name) => types.set(bare(m[1]), name)],

    // Columns declared inside CREATE TABLE are not tracked — a table's own
    // columns arrive with it, and Postgres cannot create half a table. Only
    // columns bolted on afterwards are tracked, which is where a
    // partially-applied migration actually leaves a gap.
    //
    // Matched per STATEMENT: `ALTER TABLE x ADD COLUMN a, ADD COLUMN b` is one
    // statement adding two columns, and a per-match regex only sees the first.
    [/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([a-z0-9_."]+)([\s\S]*?);/gi,
      (m, name) => {
        const table = bare(m[1]);
        const addRe = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_"]+)/gi;
        let a;
        while ((a = addRe.exec(m[2]))) columns.set(`${table}.${unquote(a[1])}`, name);
      }],

    // Drops, so a deliberate removal is not reported as missing schema.
    [/DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([a-z0-9_."]+)/gi,
      (m) => functions.delete(bare(m[1]))],
    [/DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?([a-z0-9_."]+)/gi,
      (m) => {
        const t = bare(m[1]);
        tables.delete(t);
        for (const key of [...columns.keys()]) if (key.startsWith(`${t}.`)) columns.delete(key);
      }],
    [/DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?([a-z0-9_."]+)/gi,
      (m) => types.delete(bare(m[1]))],
    [/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([a-z0-9_."]+)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z0-9_"]+)/gi,
      (m) => columns.delete(`${bare(m[1])}.${unquote(m[2])}`)],

    // Renames, which otherwise leave the old name expected for ever.
    [/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([a-z0-9_."]+)\s+RENAME\s+COLUMN\s+([a-z0-9_"]+)\s+TO\s+([a-z0-9_"]+)/gi,
      (m, name) => {
        const t = bare(m[1]);
        columns.delete(`${t}.${unquote(m[2])}`);
        columns.set(`${t}.${unquote(m[3])}`, name);
      }],
    [/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z0-9_."]+)\s+RENAME\s+TO\s+([a-z0-9_"]+)/gi,
      (m, name) => {
        tables.delete(bare(m[1]));
        tables.set(unquote(m[2]), name);
      }],
  ];

  for (const { name, sql: raw } of files) {
    const sql = sqlCode(raw);
    const events = [];
    for (const [re, apply] of EVENTS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(sql))) events.push({ at: m.index, order: events.length, apply, m });
    }
    // Array#sort is stable, but the tie-break is explicit so two regexes
    // matching at the same offset keep declaration order rather than depending
    // on it.
    events.sort((a, b) => a.at - b.at || a.order - b.order);
    for (const e of events) e.apply(e.m, name);
  }

  return { functions, tables, columns, types };
}

function readMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));
}

function catalogFromDatabase(dbUrl) {
  const out = execFileSync("psql", [dbUrl, "-At", "-c", CATALOG_SQL], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim());
}

function main() {
  const args = process.argv.slice(2);
  const offlineIdx = args.indexOf("--catalog-from");

  let catalog;
  if (offlineIdx !== -1) {
    catalog = JSON.parse(readFileSync(args[offlineIdx + 1], "utf8"));
  } else {
    const dbUrl = process.env.SUPABASE_DB_URL;
    if (!dbUrl) {
      console.error(
        "SUPABASE_DB_URL is not set.\n" +
          "This check is the guard against a migration that only half landed, so\n" +
          "it fails rather than passing silently without having checked anything.",
      );
      process.exit(2);
    }
    catalog = catalogFromDatabase(dbUrl);
  }

  const live = {
    functions: new Set((catalog.functions ?? []).map((s) => s.toLowerCase())),
    tables: new Set((catalog.tables ?? []).map((s) => s.toLowerCase())),
    columns: new Set((catalog.columns ?? []).map((s) => s.toLowerCase())),
    types: new Set((catalog.types ?? []).map((s) => s.toLowerCase())),
  };

  const expected = expectedObjects(readMigrations());

  const missing = [];
  for (const kind of ["types", "tables", "columns", "functions"]) {
    for (const [obj, file] of expected[kind]) {
      if (!live[kind].has(obj)) missing.push({ kind: kind.replace(/s$/, ""), obj, file });
    }
  }

  const counted = Object.values(expected).reduce((n, m) => n + m.size, 0);

  if (missing.length === 0) {
    console.log(
      `✓ every object the migrations create is in the database — ` +
        `${expected.types.size} type(s), ${expected.tables.size} table(s)/view(s), ` +
        `${expected.columns.size} added column(s), ${expected.functions.size} function(s); ` +
        `${counted} checked across ${readMigrations().length} migration file(s).`,
    );
    return;
  }

  console.error(
    `✗ ${missing.length} object(s) the migrations create do not exist in the database:\n` +
      missing.map((x) => `    ${x.kind.padEnd(8)} ${x.obj}\n             from ${x.file}`).join("\n") +
      "\n\nEach of these is code the repo believes it can call and the database " +
      "does not have.\nThis is what a file-level baseline cannot see: a migration " +
      "can be recorded as applied\nwhile one object inside it never landed — which " +
      "is exactly how seed_demo_org went\nmissing for a month.\n" +
      "Apply the missing object, or, if it was deliberately removed, add the DROP " +
      "to a\nmigration so the replay stops expecting it.",
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
