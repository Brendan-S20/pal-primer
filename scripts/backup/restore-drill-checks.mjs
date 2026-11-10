#!/usr/bin/env node
// The questions a person asks of a restored database before trusting it,
// answered with counts and PASS/FAIL only.
//
//   RESTORE_TARGET_URL=postgresql://...@127.0.0.1:.../postgres \
//     node scripts/backup/restore-drill-checks.mjs
//
// Run by scripts/restore-drill.sh after scripts/backup/drill.sh has restored
// an archive and compared every table's row count with the dump's own. That
// comparison says the restore is faithful TO THE DUMP. These say whether the
// dump was worth restoring:
//
//   1. tables   every public table and view the migrations leave behind is
//               there (the replay in scripts/check-baseline-objects.mjs, so
//               a table dropped by a later migration is not expected);
//   2. rows     the key tables are present and organizations is not empty;
//   3. RLS      every public table has row level security on, the same
//               "0 tables without RLS" the security advisor asserts;
//   4. auth     the auth schema and auth.users exist, with at least one row;
//   5. ledger   supabase_migrations.schema_migrations came back, and its
//               newest version, set beside the newest file in this checkout.
//
// It prints table NAMES and NUMBERS. It never selects a column value, so no
// row of customer data can reach the terminal or a log.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expectedObjects } from "../check-baseline-objects.mjs";
import { checkLocalDbUrl } from "./local-only.mjs";

/** The tables the runbook asks about by name. `staff` rather than auth.users:
 *  a restore can bring back logins and lose the table that says who works
 *  where. auth.users is checked on its own, below. */
export const DRILL_KEY_TABLES = ["organizations", "clients", "visits", "invoices", "staff"];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

export function migrationFiles(dir = MIGRATIONS) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** Public tables and views the migrations leave behind, by bare name. */
export function expectedPublicTables(files) {
  return [...expectedObjects(files).tables.keys()].filter((t) => !t.includes(".")).sort();
}

export const newestVersion = (files) => (files.length ? files.at(-1).name.split("_")[0] : null);

// One round trip, JSON out, counts and names only.
export const FACTS_SQL = `
select json_build_object(
  'relations', (select coalesce(json_agg(c.relname order by c.relname), '[]')
                  from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')),
  'rls_off',   (select coalesce(json_agg(c.relname order by c.relname), '[]')
                  from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity),
  'base_tables', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relkind in ('r','p')),
  'auth_schema', exists (select 1 from pg_namespace where nspname = 'auth'),
  'auth_users',  to_regclass('auth.users') is not null,
  'ledger',      to_regclass('supabase_migrations.schema_migrations') is not null
)`;

function psql(url, sql) {
  return execFileSync("psql", [url, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const ident = (s) => `"${s.replaceAll('"', '""')}"`;

export function gatherFacts(url) {
  const facts = JSON.parse(psql(url, FACTS_SQL));
  const present = new Set(facts.relations);
  facts.counts = {};
  for (const t of DRILL_KEY_TABLES) {
    facts.counts[t] = present.has(t)
      ? Number(psql(url, `select count(*) from public.${ident(t)}`))
      : null;
  }
  facts.auth_user_count = facts.auth_users
    ? Number(psql(url, "select count(*) from auth.users"))
    : null;
  if (facts.ledger) {
    const [n, newest] = psql(
      url,
      "select count(*) || '|' || coalesce(max(version), '') from supabase_migrations.schema_migrations",
    ).split("|");
    facts.ledger_rows = Number(n);
    facts.ledger_newest = newest || null;
  }
  return facts;
}

/**
 * Pure: facts in, lines and a verdict out. Kept apart from the database so
 * every way the drill can fail is a unit test, not a restore.
 */
export function evaluate(facts, { expectedTables, repoNewest }) {
  const lines = [];
  const failed = [];
  const check = (name, ok, detail) => {
    lines.push(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(7)} ${detail}`);
    if (!ok) failed.push(name);
  };

  const present = new Set(facts.relations);
  const missing = expectedTables.filter((t) => !present.has(t));
  check(
    "tables",
    missing.length === 0,
    `${expectedTables.length - missing.length} of ${expectedTables.length} public tables and views the migrations create are present` +
      ` (${facts.relations.length} in the restored public schema)`,
  );
  for (const t of missing.slice(0, 25)) lines.push(`        missing: public.${t}`);
  if (missing.length > 25) lines.push(`        ... and ${missing.length - 25} more`);

  const absentKeys = DRILL_KEY_TABLES.filter(
    (t) => facts.counts[t] === null || facts.counts[t] === undefined,
  );
  const noTenants = facts.counts.organizations === 0;
  check(
    "rows",
    absentKeys.length === 0 && !noTenants,
    noTenants
      ? "organizations is EMPTY: a restore of nothing proves nothing"
      : absentKeys.length
        ? `key table(s) absent: ${absentKeys.join(", ")}`
        : "key tables present and organizations is not empty",
  );
  for (const t of DRILL_KEY_TABLES) {
    const n = facts.counts[t];
    lines.push(
      `        ${t.padEnd(15)} ${n === null || n === undefined ? "absent" : String(n).padStart(9)}`,
    );
  }

  check(
    "rls",
    facts.rls_off.length === 0,
    `${facts.base_tables - facts.rls_off.length} of ${facts.base_tables} public tables have row level security on`,
  );
  for (const t of facts.rls_off.slice(0, 25)) lines.push(`        RLS off: public.${t}`);

  const authOk = facts.auth_schema && facts.auth_users && facts.auth_user_count > 0;
  check(
    "auth",
    authOk,
    !facts.auth_schema
      ? "the auth schema is missing"
      : !facts.auth_users
        ? "auth.users is missing"
        : `auth schema present, auth.users has ${facts.auth_user_count} row(s)`,
  );

  if (!facts.ledger || !facts.ledger_rows) {
    check(
      "ledger",
      false,
      `supabase_migrations.schema_migrations is ${facts.ledger ? "empty" : "absent"} in the restore, so a new project ` +
        "built from it cannot tell which migrations it already has (backups made before restore-drill.sh carried no ledger)",
    );
  } else {
    const behind = repoNewest && facts.ledger_newest < repoNewest;
    check(
      "ledger",
      true,
      `${facts.ledger_rows} migration(s) recorded, newest ${facts.ledger_newest}` +
        (repoNewest
          ? ` (this checkout's newest file: ${repoNewest}${behind ? ", newer than the backup" : ""})`
          : ""),
    );
  }

  return { ok: failed.length === 0, failed, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.RESTORE_TARGET_URL ?? "";
  const local = checkLocalDbUrl(url);
  if (!local.ok) {
    console.error(`REFUSING: ${local.reason}.`);
    process.exit(1);
  }
  const files = migrationFiles();
  const facts = gatherFacts(url);
  const result = evaluate(facts, {
    expectedTables: expectedPublicTables(files),
    repoNewest: newestVersion(files),
  });
  for (const l of result.lines) console.log(l);
  if (!result.ok) {
    console.log(`checks failed: ${result.failed.join(", ")}`);
    process.exit(1);
  }
}
