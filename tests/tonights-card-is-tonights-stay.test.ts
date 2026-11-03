// Tonight's card is tonight's stay (#653, R2-11).
//
// Round-2 audit: on night 2 of a stay the sitter's card said "Pays cash/check
// ... $850.00 due" when the stay owed $200. my_day_stop_facts added up every
// open invoice the client had, so a December stay ($500) and its deposit
// ($150, which is part of the $500) were counted on tonight's card.
//
// The SQL half runs tests/sql/tonights-card-is-tonights-stay.proof.sql against
// the local stack when one answers; it fails on the old function with the
// audit's number (88000 cents: $850 plus an older $30 invoice).
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dueCents } from "@/lib/stop-facts";

vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261102150000_tonights-card-is-tonights-stay.sql",
);
const PROOF = join(ROOT, "tests/sql/tonights-card-is-tonights-stay.proof.sql");
const sql = readFileSync(MIGRATION, "utf8");

describe("the stop card's balance", () => {
  it("is scoped to the stay for a night of a stay, and leaves out stays to come", () => {
    const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.my_day_stop_facts"));
    expect(body).toContain("WHEN sub.stay_id IS NOT NULL THEN EXISTS");
    expect(body).toContain("st.invoice_id = i.id");
    expect(body).toContain("st.deposit_invoice_id = i.id");
    expect(body).toContain("st.starts_on > a.scheduled_on");
    // Still the balance every other screen uses.
    expect(body).toContain(
      "GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0) - COALESCE(i.amount_paid_cents, 0), 0)",
    );
  });

  it("keeps the function's grants and its definer rights", () => {
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.my_day_stop_facts(uuid[]) FROM PUBLIC, anon;",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.my_day_stop_facts(uuid[]) TO authenticated, service_role;",
    );
    expect(sql).toMatch(/SECURITY DEFINER/);
  });

  it("$200 owed and nothing waiting is $200 due on the card", () => {
    expect(dueCents({ openBalanceCents: 20_000, awaitingCents: 0 })).toBe(20_000);
    expect(dueCents({ openBalanceCents: 20_000, awaitingCents: 5_000 })).toBe(15_000);
  });
});

const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

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
    `\n  SKIPPED: the tonight's-stay proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("tonight's card, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("shows $200 on night 2, not $850", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(3);
    expect(out).toMatch(/ALL TONIGHTS-STAY PROOFS PASSED/);
  });
});
