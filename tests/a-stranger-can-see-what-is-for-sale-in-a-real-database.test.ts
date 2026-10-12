// A stranger can see what is for sale: the database half.
//
// tests/sql/a-stranger-can-see-what-is-for-sale.proof.sql builds a business
// that scoops, walks and grooms (plus one with its signup switched off and one
// deleted), applies 20261011150000 inside a transaction, and proves as anon
// that public_services lists exactly the active, priced services and the
// zone-priced pet-waste one, in the Services page's order, for the right
// business only; that the ids it hands out price through public_quote; that
// the table itself stays shut; and that leads.service_id and
// signup_requests.service_id behave as the migration says. Then it ROLLS BACK.
//
// When no database is reachable it says so loudly and skips. It is NOT run
// against the shared local stack by hand (CLAUDE.md): CI runs it, or set
// PUBLIC_SERVICES_PROOF_DB_URL to a stack of your own.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIG = (f: string) => join(ROOT, "supabase/migrations", f);
const LINES = MIG("20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql");
const P1 = MIG("20261009200000_a-walk-is-not-a-cleanup.sql");
const P2 = MIG("20261009230000_a-visit-knows-its-service.sql");
const DURATIONS = MIG("20261009230100_a-walk-takes-as-long-as-the-walk.sql");
const PRICING = MIG("20261011100000_a-walk-is-priced-as-a-walk.sql");
const PUBLIC = MIG("20261011150000_a-stranger-can-see-what-is-for-sale.sql");
const PROOF = join(ROOT, "tests/sql/a-stranger-can-see-what-is-for-sale.proof.sql");
const DB_URL =
  process.env.PUBLIC_SERVICES_PROOF_DB_URL ??
  process.env.PRICING_PROOF_DB_URL ??
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
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 30_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the public-services proof did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start a stack (supabase start) or set PUBLIC_SERVICES_PROOF_DB_URL to run it.\n",
  );
}

function runProof(args: string[]) {
  let r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
    r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  }
  return r;
}

describe.skipIf(!reachable)("a stranger can see what is for sale, in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [LINES, P1, P2, DURATIONS, PRICING, PUBLIC, PROOF])
      expect(existsSync(f), f).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = runProof([
      DB_URL,
      "-X",
      "-v",
      `lines=${LINES}`,
      "-v",
      `p1=${P1}`,
      "-v",
      `p2=${P2}`,
      "-v",
      `durations=${DURATIONS}`,
      "-v",
      `pricing=${PRICING}`,
      "-v",
      `public=${PUBLIC}`,
      "-f",
      PROOF,
    ]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Three groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(3);
    expect(out).toMatch(/ALL PUBLIC SERVICE PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'For Sale Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
