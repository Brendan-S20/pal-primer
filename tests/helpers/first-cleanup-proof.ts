// Runs tests/sql/the-first-cleanup-had-no-price.proof.sql against the local
// stack, once per test file, for the three files that lean on it.
//
// When no database answers, the proof does NOT run and says so loudly. A
// silent skip would read exactly like a pass, which is the failure the
// checklist proof's runner (a-required-item-left-unchecked-refuses-the-visit)
// was written to avoid; this is the same runner, shared.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
export const FIRST_CLEANUP_MIGRATION = join(
  ROOT,
  "supabase/migrations/20260929120000_the-first-cleanup-had-no-price.sql",
);
const PROOF = join(ROOT, "tests/sql/the-first-cleanup-had-no-price.proof.sql");
const DB_URL =
  process.env.FIRST_CLEANUP_PROOF_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
export const proofDatabaseReachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim() ===
    "1";

if (!proofDatabaseReachable) {
  console.warn(
    `\n  SKIPPED: the first-cleanup SQL proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set FIRST_CLEANUP_PROOF_DB_URL to run them.\n",
  );
}

let run: { status: number | null; out: string } | null = null;
export function runFirstCleanupProof(): { status: number | null; out: string } {
  if (!run) {
    const r = spawnSync(
      psql!,
      [DB_URL, "-X", "-v", `migration=${FIRST_CLEANUP_MIGRATION}`, "-f", PROOF],
      { encoding: "utf8", timeout: 120_000 },
    );
    run = { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  }
  return run;
}

/** The `CASE|…` lines the proof prints: the database's own answer to each
 *  pricing case, for the TypeScript mirror to be held against. */
export function proofPriceCases(out: string) {
  return out
    .split("\n")
    .filter((l) => l.startsWith("CASE|"))
    .map((l) => {
      const [, cfg, zone, dogs, tier, expected] = l.split("|");
      return {
        cfg: JSON.parse(cfg) as unknown,
        zoneFlatCents: Number(zone),
        dogCount: Number(dogs),
        tierId: tier === "" ? null : tier,
        expected: expected === "null" ? null : Number(expected),
      };
    });
}
