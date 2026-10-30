import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const DB_URL =
  process.env.INVOICE_NUMBER_PROOF_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261030090000_a-failed-invoice-kept-its-number.sql",
);
const PROOF = join(ROOT, "tests/sql/a-failed-invoice-kept-its-number.proof.sql");

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
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the manual invoice number proof did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set INVOICE_NUMBER_PROOF_DB_URL to run it.\n",
  );
}

describe.skipIf(!reachable)(
  "a manual invoice is saved whole or not at all, in a real database",
  () => {
    it("has the files it runs", () => {
      expect(existsSync(MIGRATION)).toBe(true);
      expect(existsSync(PROOF)).toBe(true);
    });

    it("saves a mixed-quantity invoice, takes no number on a failed save, and leaves nothing behind", () => {
      const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
        encoding: "utf8",
        timeout: 300_000,
      });
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, out).toBe(0);
      expect(out).not.toMatch(/PROOF FAILED/);
      expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(5);

      const left = spawnSync(
        psql!,
        [
          DB_URL,
          "-XAtc",
          "select count(*) from public.organizations where id = '0a606000-0000-4000-8000-0000000000aa'",
        ],
        { encoding: "utf8" },
      );
      expect(left.stdout.trim()).toBe("0");
    });
  },
);
