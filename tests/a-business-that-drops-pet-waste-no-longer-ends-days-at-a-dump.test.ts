// A business that drops pet waste no longer ends walker days at its dump site (#980).
// Pins 20261118040000 (staff_end_point's dump tier needs pet_waste in service_lines)
// and runs its proof against a real database when one answers.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// A proof waits its turn behind others (tests/the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(__dirname, "..");
const NAME = "a-business-that-drops-pet-waste-no-longer-ends-days-at-a-dump";
const VERSION = "20261118040000";
const MIGRATION = join(ROOT, `supabase/migrations/${VERSION}_${NAME}.sql`);
const PROOF = join(ROOT, "tests/sql/a-business-that-drops-pet-waste-no-longer-ends-days-at-a-dump.proof.sql");

describe("the end-point migration, as a file", () => {
  const sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, "utf8") : "";

  it("has its migration, rollback, proof and CI wrapper", () => {
    for (const f of [
      MIGRATION,
      join(ROOT, `supabase/rollback/${VERSION}_${NAME}.down.sql`),
      PROOF,
      join(ROOT, `supabase/proofs/${VERSION}-${NAME}.sql`),
    ]) {
      expect(existsSync(f), f).toBe(true);
    }
  });

  it("holds its version alone", () => {
    const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith(VERSION))).toEqual([`${VERSION}_${NAME}.sql`]);
  });

  it("gates the dump tier on pet_waste, ahead of it, keeps the grants, and deletes no dump site", () => {
    const gate = sql.indexOf("'pet_waste' = ANY (o.service_lines)");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(sql.indexOf("FROM public.waste_disposal_facilities f"));
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public.staff_end_point\(uuid, uuid\) TO service_role/,
    );
    expect(sql).not.toMatch(
      /DELETE FROM public.waste_disposal_facilities|UPDATE public.waste_disposal_facilities/,
    );
  });
});

const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
  ]) {
    if (spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0) return p;
  }
  return null;
}
const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";
if (!reachable) {
  console.warn(`\n  SKIPPED: the ${NAME} proof did NOT run (no database at ${DB_URL}).\n`);
}

describe.skipIf(!reachable)("the end-point migration, in a real database", () => {
  it("ends days at a dump only for a business that runs pet waste", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-f", PROOF], { encoding: "utf8", timeout: 300_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED|PROOF INCONCLUSIVE/);
    expect(out).toMatch(/ALL END-POINT PROOFS PASSED/);
  });
});
