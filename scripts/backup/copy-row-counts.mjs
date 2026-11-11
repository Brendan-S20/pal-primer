#!/usr/bin/env node
// Count the rows a data dump actually holds, table by table, from the dump
// itself.
//
//   node scripts/backup/copy-row-counts.mjs data.sql [extension-state.sql] > counts.json
//
// extension-state.sql (see dump.sh) recreates the pg_cron schedule and the
// pgmq queues with one statement each; those are counted as `cron.job` and
// `pgmq.meta`, so the drill checks they came back too. It also carries the
// migration ledger, one INSERT per migration, counted as
// `supabase_migrations.schema_migrations` when there is one.
//
// ── WHY FROM THE FILE AND NOT FROM THE DATABASE ───────────────────────────
//
// The restore drill has to compare the restored database against SOMETHING.
// Counting production at backup time looks like the obvious reference and is
// the wrong one: the counts and the dump are two different moments, a row
// written between them makes the drill fail for a reason that has nothing to
// do with the backup, and a drill that fails on noise is a drill people learn
// to re-run until it is green.
//
// `pg_dump --data-only` runs in ONE snapshot, so the dump is internally
// consistent; what it holds is exactly what a restore should produce. In
// COPY text format a row is one line -- a newline inside a value is written as
// the two characters `\n` -- and a block ends at a line that is exactly `\.`
// (a value that is a backslash and a dot is written `\\.`). So counting lines
// between the header and the terminator is exact, not an estimate.
//
// The live counts are still taken (summarize.mjs) and kept beside these in
// the summary, as a WARNING-only cross-check: a large gap between production
// and its own dump is worth a human's look, but it is not the drill's question.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const HEADER = /^COPY "((?:[^"]|"")+)"\."((?:[^"]|"")+)" .*FROM stdin;$/;

export async function countCopyRows(path) {
  const counts = {};
  let current = null;
  let n = 0;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (current === null) {
      const m = HEADER.exec(line);
      if (m) {
        current = `${m[1].replaceAll('""', '"')}.${m[2].replaceAll('""', '"')}`;
        n = 0;
      }
      continue;
    }
    if (line === "\\.") {
      counts[current] = n;
      current = null;
      continue;
    }
    n += 1;
  }
  if (current !== null) {
    // A COPY block with no terminator is a truncated dump -- a disk that
    // filled, a connection that dropped mid-table. Saying "N rows" for it
    // would vouch for a file psql will refuse.
    throw new Error(`${path}: COPY block for ${current} never terminated -- the dump is truncated`);
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export async function countExtensionState(path) {
  const counts = { "cron.job": 0, "pgmq.meta": 0 };
  // Counted only when the file carries a ledger at all: an archive made
  // before dump.sh wrote one has no such table to compare, and reporting it
  // as 0 rows would make every older backup fail its own restore count.
  let ledger = 0;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.startsWith("SELECT cron.schedule(")) counts["cron.job"] += 1;
    else if (line.startsWith("SELECT pgmq.create(")) counts["pgmq.meta"] += 1;
    else if (line.startsWith("INSERT INTO supabase_migrations.schema_migrations ")) ledger += 1;
  }
  if (ledger > 0) counts["supabase_migrations.schema_migrations"] = ledger;
  return counts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: copy-row-counts.mjs <data.sql> [extension-state.sql]");
    process.exit(2);
  }
  let counts = await countCopyRows(path);
  if (Object.keys(counts).length === 0) {
    console.error(`${path}: no COPY blocks at all -- this is not a --use-copy data dump`);
    process.exit(1);
  }
  if (process.argv[3]) {
    const ext = await countExtensionState(process.argv[3]);
    counts = Object.fromEntries(
      Object.entries({ ...counts, ...ext }).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  process.stdout.write(JSON.stringify(counts, null, 2) + "\n");
}
