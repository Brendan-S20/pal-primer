#!/usr/bin/env node
// IMP-2 — fail loudly when the repo's migrations and the live database disagree.
//
// A production incident already happened from "migrations never applied to the
// live DB": the codebase can be perfectly correct while prod runs old schema,
// and nothing surfaces it until a query fails in front of a customer. This is
// the loud check.
//
// Why it is not a naive name comparison: a chunk of this repo's history was
// applied under different names and timestamps than the filenames (the
// 2026-07-09 consolidated bootstrap dump, plus a handful of later renames), so
// a plain diff reports ~80 false positives and gets ignored — which is worse
// than no check. supabase/migrations-baseline.json records exactly those
// already-verified files, so the check starts green and every NEW migration
// must genuinely show up in the database.
//
// Usage:
//   SUPABASE_DB_URL=postgres://... node scripts/check-migrations.mjs
//   node scripts/check-migrations.mjs --applied-from applied.json   (offline)
//
// Exits non-zero when a migration file has no counterpart in the database.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const BASELINE_PATH = join(ROOT, "supabase", "migrations-baseline.json");

/** Names differ in separator and case across the CLI, the dashboard and the
 *  MCP tool, so compare on a canonical form. */
const normalize = (s) => s.toLowerCase().replace(/[-_]/g, "");

function repoMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** The applied-migration names, read straight from Supabase's own ledger. */
function appliedFromDatabase(dbUrl) {
  const sql =
    "select coalesce(name, version) from supabase_migrations.schema_migrations order by version";
  let out;
  try {
    out = execFileSync("psql", [dbUrl, "-At", "-c", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const detail = (e.stderr || e.message || "").toString().trim();
    throw new Error(
      `Could not read supabase_migrations.schema_migrations.\n${detail}\n` +
        "Needs the psql client and a SUPABASE_DB_URL with rights to read that schema.",
    );
  }
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const offlineIdx = args.indexOf("--applied-from");

  let applied;
  if (offlineIdx !== -1) {
    // Escape hatch for running the check against a captured list (e.g. from an
    // MCP session) when no direct database URL is to hand.
    applied = JSON.parse(readFileSync(args[offlineIdx + 1], "utf8"));
  } else {
    const dbUrl = process.env.SUPABASE_DB_URL;
    if (!dbUrl) {
      console.error(
        "SUPABASE_DB_URL is not set.\n" +
          "This check is the guard against prod running old schema, so it fails\n" +
          "rather than passing silently without having checked anything.",
      );
      process.exit(2);
    }
    applied = appliedFromDatabase(dbUrl);
  }

  const appliedSet = new Set(applied.map(normalize));
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const baselineSet = new Set(baseline.files);

  const pending = [];
  for (const file of repoMigrations()) {
    if (baselineSet.has(file)) continue;
    const name = file.replace(/^\d+_/, "").replace(/\.sql$/, "");
    if (!appliedSet.has(normalize(name))) pending.push(file);
  }

  const checked = repoMigrations().length;
  if (pending.length === 0) {
    console.log(
      `✓ migrations in sync — ${checked} file(s) in the repo, ` +
        `${applied.length} applied, ${baseline.files.length} covered by the verified baseline.`,
    );
    return;
  }

  console.error(
    `✗ ${pending.length} migration(s) exist in the repo but not in the database:\n` +
      pending.map((f) => `    ${f}`).join("\n") +
      "\n\nApply them before this deploy goes out. The code in this commit may " +
      "depend on schema\nthat production does not have.\n" +
      "If one of these was genuinely applied under a different name, verify the " +
      "objects it\ncreates actually exist, then add the filename to " +
      "supabase/migrations-baseline.json\nwith that evidence — never to silence the check.",
  );
  process.exit(1);
}

main();
