// A directory profile may publish a contact email and phone (#969; mypets PR #18).
//
// Pins 20261118010000: numbered after every migration on main, additive,
// no BEGIN/COMMIT (the proof applies it inside its own transaction), CHECKs
// on both columns, the view keeping security_barrier and its grants, and a
// rollback file. Runs tests/sql/a-directory-profile-can-publish-a-contact.proof.sql
// against a real database when one answers (skipped, loudly, when none does).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// A proof waits its turn behind others (tests/the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(__dirname, "..");
const NAME = "a-directory-profile-can-publish-a-contact";
const VERSION = "20261118010000";
const MIGRATION = join(ROOT, `supabase/migrations/${VERSION}_${NAME}.sql`);
const ROLLBACK = join(ROOT, `supabase/rollback/${VERSION}_${NAME}.down.sql`);
const PROOF = join(ROOT, "tests/sql/a-directory-profile-can-publish-a-contact.proof.sql");

describe("the contact migration, as a file", () => {
  const sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, "utf8") : "";

  it("has its migration, rollback, proof and CI wrapper", () => {
    for (const f of [MIGRATION, ROLLBACK, PROOF, join(ROOT, `supabase/proofs/${VERSION}-${NAME}.sql`)]) {
      expect(existsSync(f), f).toBe(true);
    }
  });

  it("holds its version alone and sorts after the directory migrations it builds on", () => {
    const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith(VERSION))).toEqual([`${VERSION}_${NAME}.sql`]);
    expect(VERSION > "20261112110000").toBe(true);
  });

  it("adds two nullable columns idempotently and drops nothing", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS public_email text;/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS public_phone text;/);
    expect(sql).not.toMatch(/ADD COLUMN[^;]*NOT NULL/);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN|VIEW|FUNCTION)/i);
  });

  it("has no transaction control of its own", () => {
    expect(sql).not.toMatch(/^(BEGIN|COMMIT);/m);
  });

  it("checks both shapes", () => {
    expect(sql).toMatch(/directory_profiles_public_email_check/);
    expect(sql).toMatch(/directory_profiles_public_phone_check/);
    expect(sql).toMatch(/\\\+\[1-9\]\[0-9\]\{7,14\}/);
  });

  it("keeps the view's barrier and grants, and appends the two columns last", () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.directory_public_listings\s+WITH \(security_barrier = true\)/);
    expect(sql).toMatch(/GRANT SELECT ON public\.directory_public_listings TO anon, authenticated;/);
    expect(sql).toMatch(/GRANT SELECT ON public\.directory_public_listings TO service_role;/);
    expect(sql).toMatch(/AS photos,\n\s+p\.public_email,\n\s+p\.public_phone\n\s+FROM public\.directory_profiles p/);
  });
});

const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of ["psql", "/opt/homebrew/opt/libpq/bin/psql", "/opt/homebrew/opt/postgresql@17/bin/psql"]) {
    if (spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0) return p;
  }
  return null;
}
const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim() === "1";
if (!reachable) {
  console.warn(`\n  SKIPPED: the ${NAME} proof did NOT run (no database at ${DB_URL}).\n`);
}

describe.skipIf(!reachable)("the contact migration, in a real database", () => {
  it("defaults, accepts good shapes, refuses bad ones, never leaks, and the mutation reproduces", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED|PROOF INCONCLUSIVE/);
    expect((out.match(/ok:/g) ?? []).length).toBe(6);
  });
});
