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
    throw new Error(
      `Could not read pg_proc.\n${detail}\nNeeds the psql client and a SUPABASE_DB_URL.`,
    );
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** One entry per migration, rather than every file concatenated.
 *
 *  The dynamic form below has to be judged per FILE: it asks whether one
 *  migration both executes constructed DDL and then asserts this function
 *  exists. Joined into a single string those two halves could come from
 *  unrelated files a year apart and still satisfy it. */
function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));
}

/** A GRANT or a comment mentioning the name is not a definition — the whole
 *  point is that email_queue_wake appeared in a migration's GRANT list while
 *  being defined nowhere. Only a CREATE FUNCTION counts — spelled out here, or
 *  constructed and executed, which `createsDynamically` below judges separately
 *  and on stricter terms.
 *
 *  The first version of this said exactly that in the comment and then matched
 *  /FUNCTION\s+(public\.)?name\s*\(/ — which `GRANT EXECUTE ON FUNCTION
 *  public.name(uuid) TO authenticated` satisfies, and so does `DROP FUNCTION`.
 *  So the check shipped with the precise hole it was written to close, and two
 *  live functions (cast_roadmap_vote, roadmap_vote_counts) were passing through
 *  it while being defined in no migration at all. The CREATE is the part that
 *  makes an object exist in a rebuilt database; a mention of the name is not
 *  one. */
export function createsLiterally(sql, fn) {
  return new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${fn}\\s*\\(`, "i").test(
    sql,
  );
}

/** The CREATE is not always spelled out. `plan_visits` is spliced out of
 *  `pg_get_functiondef('public.plan_route(...)')` — two clauses replaced — and
 *  brought into existence by `EXECUTE _def;`, deliberately, so that the ~150
 *  line solver is not copied by hand into a second implementation that agrees
 *  today and diverges the first time anyone touches either. There is no literal
 *  `CREATE FUNCTION public.plan_visits(` anywhere in the repo, and there is not
 *  supposed to be.
 *
 *  So the check reported it as undeclared, which is the one thing it must not
 *  do: this script's whole argument is that a false positive is worse than no
 *  check, because a gate that cries wolf gets ignored. A rebuilt database DOES
 *  get plan_visits — the migration creates it and then refuses to finish if it
 *  did not, which is a stronger guarantee than a literal CREATE, since a CREATE
 *  inside a branch that never fires would sail through the regex above.
 *
 *  Both halves are required, and the hole this script was written to close
 *  stays closed. A GRANT or a DROP mentioning the name has no EXECUTE of
 *  constructed DDL. And `IS NULL` is load-bearing: a migration REMOVING a
 *  function guards with `IS NOT NULL`, so the drop direction cannot count as a
 *  declaration. What is being matched is a migration saying "I fail unless this
 *  function exists when I am done". */
export function createsDynamically(sql, fn) {
  const executesBuiltDdl = /\bEXECUTE\s+(_\w+\s*;|format\s*\()/i.test(sql);
  const assertsItExists = new RegExp(
    `to_regprocedure\\(\\s*'public\\.${fn}\\([^']*'\\s*\\)\\s*IS\\s+NULL`,
    "i",
  ).test(sql);
  return executesBuiltDdl && assertsItExists;
}

export function isDeclared(files, fn) {
  return files.some(({ sql }) => createsLiterally(sql, fn) || createsDynamically(sql, fn));
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
  const files = migrationFiles();

  const undeclared = live.filter((fn) => !allowed.has(fn) && !isDeclared(files, fn));

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

// Only when run as a command, so the test can import the predicates above.
if (process.argv[1] && process.argv[1].endsWith("check-schema-declared.mjs")) {
  main();
}
