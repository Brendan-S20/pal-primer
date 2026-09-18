import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// One payment, two separate Stripe disputes of $400 each, both lost, both
// settled, then both won. Proven live before this was written:
//
//   before   deducted=80000   repayments=1  repaid=40000
//   after    deducted=80000   repayments=2  repaid=80000
//
// A repayment row wrote `cumulative_cents = _orig.amount_cents`, so two
// disputes of the same size produced the same key under
// franchise_adjustments_payment_kind_cumulative_key, and the second INSERT hit
// `ON CONFLICT ... DO NOTHING` — the clause written to make webhook redelivery
// harmless. It could not tell a redelivery from a second dispute because the
// key it arbitrated on cannot. The location stayed $400 down, silently.
//
// Equal amounts are not a corner case: a location billing a flat monthly rate
// disputes the same figure every time.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** CREATE OR REPLACE means the LAST definition is the one that runs. */
function latestDefinitionOf(fn: string): string {
  const re = new RegExp(`FUNCTION\\s+public\\.${fn}\\s*\\(`, "i");
  let found = "";
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql;
  }
  return found;
}

/** Likewise for an index: the last migration that creates it. `IF NOT EXISTS`
 *  is optional and both spellings are in use here — leaving it out of the
 *  pattern made this return "" for an index that plainly exists, which the
 *  "finds it at all" guard above is here to catch. */
function latestIndexSql(name: string): string {
  const re = new RegExp(
    `CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${name}\\b[\\s\\S]*?;`,
    "i",
  );
  let found = "";
  for (const f of migrationFiles()) {
    const m = re.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    if (m) found = m[0];
  }
  return found;
}

describe("which uniqueness rule owns which row", () => {
  it("finds the cumulative index at all", () => {
    // Every assertion below is a regex over this string, and every regex over
    // "" that uses .not is a pass measuring nothing.
    expect(
      latestIndexSql("franchise_adjustments_payment_kind_cumulative_key").length,
    ).toBeGreaterThan(0);
  });

  it("scopes the cumulative index to rows with no dispute id", () => {
    // Cumulative amount is the right identity for a REFUND, where Stripe sends
    // `amount_refunded` as a running total and re-billing a partial refund is
    // the thing to prevent. It is the wrong identity for a dispute.
    expect(latestIndexSql("franchise_adjustments_payment_kind_cumulative_key")).toMatch(
      /WHERE\s+dispute_ref\s+IS\s+NULL/i,
    );
  });

  it("keeps a uniqueness rule for rows that DO carry a dispute id", () => {
    // Making the first index partial without this would leave dispute rows
    // with no uniqueness rule at all — worse than the bug being fixed. This
    // index predates the fix; the assertion is that it was not dropped.
    const sql = latestIndexSql("franchise_adjustments_payment_kind_dispute_key");
    expect(sql).toMatch(/dispute_ref/);
    expect(sql).toMatch(/WHERE\s+\(?dispute_ref\s+IS\s+NOT\s+NULL/i);
  });
});

describe("record_franchise_adjustment", () => {
  const sql = latestDefinitionOf("record_franchise_adjustment");

  it("finds the routine at all", () => {
    expect(sql.length).toBeGreaterThan(0);
  });

  it("does not name the cumulative index as its conflict target", () => {
    // A named target must match an index exactly, so with a partial index the
    // predicate would have to be repeated at both call sites — a second place
    // to get it wrong. Bare DO NOTHING means "if any uniqueness rule says this
    // row exists, we are done", which is what the guard was always for.
    const fn = sql.slice(sql.indexOf("FUNCTION public.record_franchise_adjustment"));
    const body = fn.slice(0, fn.indexOf("$function$;"));
    expect(body).not.toMatch(/ON\s+CONFLICT\s*\(/i);
    // Both INSERTs — the repayment and the deduction — must still be guarded.
    expect(body.match(/ON\s+CONFLICT\s+DO\s+NOTHING/gi)?.length).toBe(2);
  });

  it("still refuses the kinds that move no money", () => {
    // Unrelated to this fix, and the reason the guard list is worth pinning: a
    // kind that falls through to the generic branch is billed as a brand-new
    // deduction, so a lost $1,000 chargeback would be charged twice.
    const fn = sql.slice(sql.indexOf("FUNCTION public.record_franchise_adjustment"));
    expect(fn).toMatch(/'chargeback_lost'/);
    expect(fn).toMatch(/'dispute_inquiry'/);
    expect(fn).toMatch(/'dispute_inquiry_closed'/);
  });

  it("keeps the idempotency check that a re-presented dispute would trip", () => {
    // Deliberately NOT loosened. The same audit flagged that this EXISTS has no
    // status filter, so a dispute won and then lost again under the SAME id
    // files nothing — which reproduces. But Stripe closes a dispute once; a
    // second dispute on a charge is a new dispute with a new id (see
    // src/lib/disputes.ts). The scenario is unreachable and the redelivery this
    // guards against is routine, so loosening it would trade a bug that cannot
    // happen for double-billing that can. If this assertion ever fails, that
    // trade is being made — make it deliberately.
    const fn = sql.slice(sql.indexOf("FUNCTION public.record_franchise_adjustment"));
    expect(fn).toMatch(/dispute_ref\s*=\s*_ref\s*\n\s*\)\s*THEN/);
  });
});
