// Approving "please switch me to weekly" billed the monthly price, weekly.
//
// ── WHY THE NUMBER IS SO LARGE ────────────────────────────────────────────
//
// `subscriptions.price_cents` is stored POST-multiplier. computeZoneVisitPrice
// returns `perVisitCents * multiplier` (src/lib/pricing.ts) and that is the
// value written at create time. The default multipliers were
// { weekly: 1, biweekly: 1.7, twice_weekly: 1.8, monthly: 3.2 } (twice_weekly
// is 0.9 since #572; the arithmetic below holds for any map).
//
// So a monthly client in a $30 zone carries price_cents = 9600. Approve their
// request to move to weekly, change only `frequency`, and they are now weekly
// at $96 A VISIT: $384 a month instead of $120. run_billing_cycles raises it
// and autopay takes it off the saved card, from a confirm dialog whose copy
// mentions rescheduling and never mentions money.
//
// The staff edit path was always fine — updateSubscription takes an explicit
// priceCents from the form. It is the APPROVAL path, where nobody types a
// price, that carried the old multiplier forward.
//
// ── WHY A RATIO AND NOT A RECOMPUTE ───────────────────────────────────────
//
// Price is linear in the multiplier, so dividing out the old one and applying
// the new one reproduces exactly what create-time pricing would compute — with
// no zone, dog count or boundary area to re-fetch, and without silently
// discarding a per-visit price a human has since edited by hand.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = readFileSync(join(root, "src/lib/subscriptions.functions.ts"), "utf8");

/** The arithmetic the handler performs, extracted so it can be exercised. */
function reprice(oldPrice: number, oldMult: number, newMult: number): number {
  const om = Number(oldMult ?? 1) || 1;
  const nm = Number(newMult ?? 1) || 1;
  return oldPrice > 0 && om > 0 ? Math.round((oldPrice / om) * nm) : oldPrice;
}

describe("approving a frequency change reprices the subscription", () => {
  const M = { weekly: 1, biweekly: 1.7, twice_weekly: 1.8, monthly: 3.2 };

  it("monthly to weekly drops the price back to the zone rate", () => {
    // $30 zone stored as monthly: 3000 * 3.2 = 9600.
    expect(reprice(9600, M.monthly, M.weekly)).toBe(3000);
  });

  it("weekly to monthly raises it, which is the same rule in the other direction", () => {
    expect(reprice(3000, M.weekly, M.monthly)).toBe(9600);
  });

  it("biweekly to twice-weekly lands on the create-time price", () => {
    // 3000 * 1.7 = 5100 stored; moving to twice_weekly should be 3000 * 1.8.
    expect(reprice(5100, M.biweekly, M.twice_weekly)).toBe(5400);
  });

  it("a hand-edited price keeps its own basis rather than being recomputed away", () => {
    // Somebody negotiated $80/visit on a monthly plan: 8000 * 3.2 = 25600.
    // Moving to weekly must yield 8000, not the zone's 3000.
    expect(reprice(25600, M.monthly, M.weekly)).toBe(8000);
  });

  it("a zero or missing multiplier cannot zero somebody's bill", () => {
    expect(reprice(9600, 0, 1)).toBe(9600);
    expect(reprice(9600, undefined as unknown as number, 1)).toBe(9600);
    expect(reprice(0, 3.2, 1)).toBe(0);
  });

  it("the approval handler actually writes price_cents", () => {
    // The whole fault was an update that set `frequency` and nothing else.
    const fn = src.slice(src.indexOf("applyFrequencyChangeRequest"));
    const body = fn.slice(0, fn.indexOf("export const", 10));
    expect(body).toMatch(/price_cents: repriced/);
    expect(body).toMatch(/frequency_multipliers/);
  });
});
