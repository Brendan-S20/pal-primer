#!/usr/bin/env node
// Prove a restore brought back what the backup holds.
//
//   node scripts/backup/verify-restore.mjs <opened-dir> <restored-db-url> [summary.json]
//
// Three questions, and the drill fails on any of them:
//
//   1. Is every table the dump holds in the restored database with EXACTLY
//      the number of rows the dump holds? Not "about": counts.json is counted
//      from the dump file itself (copy-row-counts.mjs), so the only way to
//      differ is a restore that lost or invented rows.
//   2. Is it a restore of something? organizations and auth.users must not be
//      empty. "Every count matches" is true of a backup of nothing, and a
//      drill that cannot tell that apart from success proves nothing.
//   3. Does every foreign key still hold? See no-orphans-after-restore.sql:
//      rows are loaded with triggers off, and that includes the triggers that
//      ARE foreign keys.
//
// With summary.json it also checks that the archive's own counts.json agrees
// with the summary written the night it was made -- so the drill reads the
// archive it was given, not a different night's.
//
// Prints table names and numbers only, and a table's row count only when the
// drill failed (see the end of this file).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY_TABLES, MUST_NOT_BE_EMPTY } from "./key-tables.mjs";

const [dir, url, summaryPath] = process.argv.slice(2);
if (!dir || !url) {
  console.error("usage: verify-restore.mjs <opened-dir> <restored-db-url> [summary.json]");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const failures = [];

const expected = JSON.parse(readFileSync(join(dir, "counts.json"), "utf8"));
const names = Object.keys(expected);

if (summaryPath) {
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (JSON.stringify(summary.tables) !== JSON.stringify(expected)) {
    failures.push("the archive's counts.json does not match the summary written with it -- wrong archive, or a damaged one");
  }
}

const quote = (t) => {
  const i = t.indexOf(".");
  const q = (s) => `"${s.replaceAll('"', '""')}"`;
  return `${q(t.slice(0, i))}.${q(t.slice(i + 1))}`;
};
const lit = (s) => `'${s.replaceAll("'", "''")}'`;

const rows = (sql) =>
  execFileSync("psql", [url, "-X", "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));

// Which tables exist first, so a table that did not restore at all reports as
// missing instead of aborting the count of every other table.
const present = new Set(
  rows(names.map((t) => `select ${lit(t)} where to_regclass(${lit(quote(t))}) is not null`).join(" union all ")).map(
    ([t]) => t,
  ),
);
const actual = {};
for (const t of names) if (!present.has(t)) actual[t] = -1;
const toCount = names.filter((t) => present.has(t));
if (toCount.length) {
  for (const [t, n] of rows(toCount.map((t) => `select ${lit(t)}, count(*) from ${quote(t)}`).join(" union all "))) {
    actual[t] = Number(n);
  }
}

let matched = 0;
for (const t of names) {
  const want = expected[t];
  const got = actual[t];
  if (got === -1) failures.push(`${t}: in the backup (${want} rows) and absent from the restored database`);
  else if (got !== want) failures.push(`${t}: backup holds ${want} rows, restored database has ${got}`);
  else matched += 1;
}
for (const t of KEY_TABLES) {
  if (!(t in expected)) failures.push(`${t}: a key table, and not in the backup at all`);
}
for (const t of MUST_NOT_BE_EMPTY) {
  if (expected[t] === 0) failures.push(`${t}: EMPTY in the backup -- a drill that restores nothing proves nothing`);
}

console.log(`${matched} of ${names.length} tables restored with exactly the rows the backup holds`);

try {
  // The SQL reports constraint names and counts only, so its output is safe
  // to show as it is.
  execFileSync(
    "psql",
    [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", join(here, "no-orphans-after-restore.sql")],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
} catch {
  failures.push("foreign keys do not all hold in the restored database (see above)");
}

// The key tables' own counts are printed only when something failed. This
// runs in a PUBLIC repository's logs (backup.yml's Sunday drill and
// restore-drill.yml), where "N of N match" is all a pass needs to say, and
// how many customers and logins production has is nobody else's business.
// On a failure the numbers are what a person needs to see first.
if (failures.length) {
  for (const t of KEY_TABLES) {
    console.log(`  ${t.padEnd(22)} backup ${String(expected[t] ?? "-").padStart(8)}   restored ${String(actual[t] ?? "-").padStart(8)}`);
  }
  for (const f of failures) console.log(`::error::${f}`);
  process.exit(1);
}
console.log("restore verified");
