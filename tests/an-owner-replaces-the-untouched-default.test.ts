import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

vi.setConfig({ testTimeout: 300_000 });

const migration = resolve(
  "supabase/migrations/20261112050000_an-owner-replaces-the-untouched-default-service.sql",
);
const proof = resolve("tests/sql/an-owner-replaces-the-untouched-default.proof.sql");
const ciProof = resolve(
  "supabase/proofs/20261112050000-an-owner-replaces-the-untouched-default.sql",
);

it("runs the same proof through the database job, without needing a migration variable", () => {
  const include = readFileSync(ciProof, "utf8").match(/^\\ir\s+(\S+)$/m);
  expect(include).not.toBeNull();
  expect(resolve(dirname(ciProof), include![1])).toBe(proof);
  expect(readFileSync(proof, "utf8")).toMatch(/\\if :\{\?migration\}\s+\\i :migration\s+\\endif/);
  expect(readFileSync(resolve(".github/workflows/sandboxes.yml"), "utf8")).toContain(
    "for f in supabase/proofs/*.sql; do",
  );
});

const db =
  process.env.SERVICES_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const psql = process.env.PSQL ?? "psql";
const available =
  spawnSync(psql, [db, "-XAtc", "select 1"], { encoding: "utf8", timeout: 5000 }).stdout?.trim() ===
  "1";

describe.skipIf(!available)(
  "an owner replaces only the untouched, unused starter (Postgres)",
  () => {
    it("proves Add service, repeated adds, preservation, isolation, references and failed writes", () => {
      const result = spawnSync(psql, [db, "-X", "-v", `migration=${migration}`, "-f", proof], {
        encoding: "utf8",
        timeout: 300000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 300000);
  },
);
