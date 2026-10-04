#!/usr/bin/env node
// Write the backup's summary: the small, UNENCRYPTED record of what a backup
// holds, kept beside the encrypted archive for monitoring and read by the
// restore drill.
//
//   SUPABASE_DB_URL=... node scripts/backup/summarize.mjs <dump-dir> <archive.gpg> <summary.json>
//
// ── WHAT IS IN IT, AND WHAT IS DELIBERATELY NOT ───────────────────────────
//
// Table names and row counts, file sizes, the archive's sha256, versions and
// timestamps. No row, no column value, no name, no address, no email: it is
// uploaded in the clear and is meant to be read by anyone watching the
// backups. Counts are business-sensitive at most; they identify nobody.
//
// ── TWO KINDS OF COUNT ────────────────────────────────────────────────────
//
// `tables` is counted FROM THE DUMP (copy-row-counts.mjs) and is what the
// drill must reproduce exactly. `key_tables[].live` is counted from
// production a moment after the dump finished, and is a cross-check that
// WARNS: production keeps taking writes while the dump runs, so a small
// difference is expected and a failure on it would be a failure on noise.
// A large one -- a key table at half its live size -- is worth a person's
// look, and the warning puts it in the run's annotations.
//
// What it does FAIL on: a key table absent from the dump (pg_dump writes an
// empty COPY block for an empty table, so absent means excluded or never
// read), and an empty organizations or auth.users. Production has tenants and
// accounts; a backup that holds neither is not a backup, however cleanly it
// encrypted.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { KEY_TABLES, MUST_NOT_BE_EMPTY } from "./key-tables.mjs";

const [dir, archive, out] = process.argv.slice(2);
if (!dir || !archive || !out) {
  console.error("usage: summarize.mjs <dump-dir> <archive.gpg> <summary.json>");
  process.exit(2);
}

const sha256 = (path) =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

const tables = JSON.parse(readFileSync(join(dir, "counts.json"), "utf8"));
const problems = [];
for (const t of KEY_TABLES) {
  if (!(t in tables)) problems.push(`${t} is not in the dump at all`);
}
for (const t of MUST_NOT_BE_EMPTY) {
  if (tables[t] === 0) problems.push(`${t} is EMPTY in the dump; production is not`);
}

// Live counts and the server version. Optional so the script also runs
// against a local dump with no production URL; the workflow always sets it.
let live = null;
let serverVersion = null;
const url = process.env.SUPABASE_DB_URL;
if (url) {
  const sql =
    "select json_build_object('server_version_num', current_setting('server_version_num')" +
    KEY_TABLES.map((t) => `, '${t}', (select count(*) from ${t})`).join("") +
    ")";
  try {
    const raw = execFileSync("psql", [url, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(raw.trim());
    serverVersion = Number(parsed.server_version_num);
    delete parsed.server_version_num;
    live = parsed;
  } catch {
    // psql's error text can carry the connection string, and that must never
    // reach a log. Say what failed, not what was dialled.
    console.log("::warning::could not take live counts for the cross-check; the backup itself is unaffected");
  }
}

if (live) {
  for (const t of KEY_TABLES) {
    const d = tables[t];
    const l = live[t];
    if (typeof d !== "number" || typeof l !== "number" || d === l) continue;
    const gap = Math.abs(l - d);
    // Writes land during the dump, so a handful of rows of drift is normal. A
    // gap of more than 2% (and more than 5 rows) is not drift.
    const large = gap > 5 && gap > l * 0.02;
    const msg = `${t}: ${d} rows in the dump, ${l} live a moment later`;
    console.log(large ? `::warning::${msg} -- more than writes during a dump explain` : `  ${msg} (writes during the dump)`);
  }
}

const plaintext = {};
for (const f of ["roles.sql", "schema.sql", "data.sql"]) plaintext[f] = statSync(join(dir, f)).size;

const summary = {
  format: 1,
  created_at: new Date().toISOString(),
  archive: {
    name: basename(archive),
    bytes: statSync(archive).size,
    sha256: await sha256(archive),
    encryption: "OpenPGP symmetric, AES256, s2k SHA512",
  },
  plaintext_bytes: plaintext,
  server_version_num: serverVersion,
  supabase_cli: process.env.SUPABASE_CLI_VERSION || null,
  git_sha: process.env.GITHUB_SHA || null,
  run_id: process.env.GITHUB_RUN_ID || null,
  key_tables: Object.fromEntries(
    KEY_TABLES.map((t) => [t, { dumped: tables[t] ?? null, live: live ? (live[t] ?? null) : null }]),
  ),
  tables,
};
writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");

const total = Object.values(tables).reduce((a, b) => a + b, 0);
console.log(`\n${Object.keys(tables).length} tables, ${total} rows, archive ${summary.archive.bytes} bytes`);
for (const t of KEY_TABLES) console.log(`  ${t.padEnd(22)} ${String(tables[t] ?? "MISSING").padStart(8)}`);

if (problems.length) {
  for (const p of problems) console.log(`::error::${p}`);
  process.exit(1);
}
