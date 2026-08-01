#!/usr/bin/env node
// The other direction of drift: objects the DATABASE has that the REPO never
// wrote.
//
// scripts/check-migrations.mjs compares migration files to Supabase's applied
// ledger. It answers "did production run everything the repo has". It cannot
// answer "does production have something no migration creates", and that is the
// direction that stays invisible, because nothing fails until an environment is
// rebuilt from the repo and an object simply is not there.
//
// It had already happened three times when this was written. Auditing the
// BUILD-6 franchise money paths turned up set_chargeback_responsibility — a
// SECURITY DEFINER function deciding who absorbs every chargeback, reachable
// from a shipped screen, defined in no migration. A comment pointed at the
// migration that supposedly created it; that migration creates one function and
// it is not this one. Sweeping the rest of the schema found two more
// (rls_auto_enable, email_queue_wake), both Lovable scaffold leftovers, one of
// them carrying a service_role key to a third-party host.
//
// Usage:
//   SUPABASE_DB_URL=postgres://... node scripts/check-schema-declared.mjs
//   node scripts/check-schema-declared.mjs --live-from live.json   (offline)
//
// The offline form takes a JSON array of function names, which is how to run it
// from an MCP session with no direct database URL.
//
// Exits non-zero when a live function has no definition in any migration.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const BASELINE_PATH = join(ROOT, "supabase", "schema-declared-baseline.json");

/** Functions Supabase itself installs into `public`. They are the platform's to
 *  manage, not ours, and no migration should be claiming them. Anything added
 *  here needs a reason in the baseline file, not just a name. */
function liveFromDatabase(dbUrl) {
  const sql =
    "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
    "where n.nspname = 'public' and p.prokind = 'f' order by p.proname";
  let out;
  try {
    out = execFileSync("psql", [dbUrl, "-At", "-c", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const detail = (e.stderr || e.message || "").toString().trim();
    throw new Error(`Could not read pg_proc.\n${detail}\nNeeds the psql client and a SUPABASE_DB_URL.`);
  }
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function allMigrationSql() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n");
}

/** A GRANT or a comment mentioning the name is not a definition — the whole
 *  point is that email_queue_wake appeared in a migration's GRANT list while
 *  being defined nowhere. Only a CREATE FUNCTION counts. */
function isDeclared(sql, fn) {
  return new RegExp(`FUNCTION\\s+(public\\.)?${fn}\\s*\\(`, "i").test(sql);
}

function main() {
  const args = process.argv.slice(2);
  const offlineIdx = args.indexOf("--live-from");

  let live;
  if (offlineIdx !== -1) {
    live = JSON.parse(readFileSync(args[offlineIdx + 1], "utf8"));
  } else {
    const dbUrl = process.env.SUPABASE_DB_URL;
    if (!dbUrl) {
      console.error(
        "SUPABASE_DB_URL is not set.\n" +
          "This check exists because undeclared schema is invisible until a rebuild,\n" +
          "so it fails rather than passing silently without having checked anything.",
      );
      process.exit(2);
    }
    live = liveFromDatabase(dbUrl);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const allowed = new Set(Object.keys(baseline.allowed));
  const sql = allMigrationSql();

  const undeclared = live.filter((fn) => !allowed.has(fn) && !isDeclared(sql, fn));

  // A baseline entry for a function that no longer exists is stale, and a stale
  // allow-list is how a real finding gets waved through later.
  const liveSet = new Set(live);
  const staleAllowances = [...allowed].filter((fn) => !liveSet.has(fn));

  if (undeclared.length === 0 && staleAllowances.length === 0) {
    console.log(
      `✓ every live function is declared — ${live.length} in public, ` +
        `${allowed.size} platform-owned by baseline.`,
    );
    return;
  }

  if (undeclared.length) {
    console.error(
      `✗ ${undeclared.length} function(s) exist in the database but in no migration:\n` +
        undeclared.map((f) => `    ${f}`).join("\n") +
        "\n\nA rebuilt environment will not have these. Read the live definition, decide\n" +
        "whether it should exist at all, then either file it into a migration verbatim\n" +
        "or drop it. Add it to supabase/schema-declared-baseline.json only if Supabase\n" +
        "owns it — with the reason, never to silence the check.",
    );
  }
  if (staleAllowances.length) {
    console.error(
      `\n✗ ${staleAllowances.length} baseline allowance(s) name a function that no longer exists:\n` +
        staleAllowances.map((f) => `    ${f}`).join("\n") +
        "\n\nRemove them, so the allow-list keeps meaning what it says.",
    );
  }
  process.exit(1);
}

main();
