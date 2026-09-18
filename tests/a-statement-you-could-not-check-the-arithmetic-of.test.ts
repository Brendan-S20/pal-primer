import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeSettlement,
  settlementMoney,
  settlementSignedMoney,
  type SettlementRow,
} from "@/lib/franchise-settlement";

// The settlement statement prints one line of arithmetic under each period, so
// that neither side has to take the headline net on trust:
//
//     Revenue $10,000.00 · royalty 10% = $1,000.00 · adjustments $50.00
//
// Three separate things were wrong with that line, and all three leave a
// perfectly plausible number on the screen. This is the money surface a
// franchisee disputes against.
//
// ── 1. THE ADJUSTMENT'S SIGN WAS THROWN AWAY ──────────────────────────────
//
// `settlementMoney` takes an absolute value, on purpose and correctly: it was
// written for `net_due_cents`, which is always stored positive with its
// direction carried by the `direction` column, and the component adds the "+"
// or "-" from `flow`. `adjustments_applied_cents` is not that kind of number.
// The generator writes it as
//
//     adjustments_applied_cents = loc_owes − fran_owes
//
// an INPUT to  balance = collected_by_franchise − royalty − adjustments,  and
// it goes negative whenever the franchise is the party absorbing a reversal.
// That is not an exotic case: it is every refund on a location-collected charge
// at a location whose `chargeback_responsibility` is 'franchise' — the entire
// purpose of that setting — the proportional share under 'split', and every
// won-dispute repayment, whose shares `record_franchise_adjustment` stores
// negated.
//
// Rendered through `settlementMoney` those printed as "adjustments $50.00": a
// credit shown as a charge, on the line whose only job is to let both sides
// check the net. Nothing else disagreed loudly enough to notice, because the
// net itself was right — the only symptom was a statement that did not add up.
//
// ── 2. "REVENUE" MEANT TWO DIFFERENT THINGS ON ONE SCREEN ─────────────────
//
// `revenue_cents` is GROSS: `sum(payments.amount_cents)` over
// `status IN ('succeeded','refunded')` for the period. Refunds are not netted
// out of it; they travel separately as adjustments, which is deliberate and
// documented in src/lib/revenue.ts ("receipt where it happened, reversal where
// it happened").
//
// Six inches up the same page, `franchise_rollup` labels its gross "Collected"
// and reserves the word "Revenue" for the figure NET of the month's refunds —
// "Net revenue MTD". The rate editor between them says "% of collected
// revenue". So the statement used the page's word for net to name its gross.
// That is the fault this codebase has already fixed twice, running the other
// way: a figure headed "Revenue" whose arithmetic is not the page's revenue.
//
// ── 3. THE NET FOLLOWED FROM NONE OF THE FIGURES BESIDE IT ────────────────
//
//     net_due = |revenue_the_franchise_collected − royalty − adjustments|
//
// The line printed revenue, royalty and adjustments and never
// `revenue_collected_by_parent_cents`. When the location collected everything
// that is invisible, because the term is zero. On a period the franchise
// collected part of — the primary arrangement, per the 2026-07-30 owner
// decision — the reader is shown three numbers and a net that cannot be
// derived from them. The generator has written the split since 2026-07-30 and
// `listRoyaltyInvoices` did not select it, so no screen had ever shown it.
//
// ── LIVE NUMBERS, measured 2026-08-19 against vsxzrbxublqrcfnxfwcu ─────────
//
// `franchise_royalty_invoices` and `franchise_adjustments` are both EMPTY, and
// every `franchise_royalty_percent` in the database is 0.00, so no statement
// has ever been rendered in production and none of the three faults has yet
// misinformed anyone. The one franchise is "Demo Pet Waste Co" with two
// locations. Replaying `generate_franchise_settlements`' own SELECT over
// July 2026 (2026-07-01 → 2026-08-01, cut in the parent's America/New_York) at
// a hypothetical 7% gives the worked figures used below:
//
//   Northside   revenue 131800  by_parent 0  royalty  9226  net  9226  location owes
//   Southside   revenue 137600  by_parent 0  royalty  9632  net  9632  location owes
//
// The mixed-collector case below is constructed, not measured: no location in
// the database has `payments_collected_by_parent` set, so every live payment
// was collected by the org that earned it.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const row = (over: Partial<SettlementRow>): SettlementRow => ({
  id: "s1",
  period_start: "2026-07-01",
  period_end: "2026-08-01",
  revenue_cents: 1_318_00,
  royalty_percent: "7.00",
  royalty_cents: 9226,
  amount_cents: 9226,
  adjustments_applied_cents: 0,
  direction: "location_owes_franchise",
  net_due_cents: 9226,
  status: "draft",
  ...over,
});

describe("an adjustment keeps the sign that says which way it went", () => {
  it("prints a deduction from the location as a positive figure", () => {
    expect(settlementSignedMoney(5_000)).toBe("$50.00");
  });

  it("prints a credit the franchise is absorbing as a NEGATIVE figure", () => {
    // The 'franchise' and 'split' chargeback_responsibility cases, and every
    // won-dispute repayment. Through settlementMoney this read "$50.00".
    expect(settlementSignedMoney(-5_000)).toBe("-$50.00");
    expect(settlementMoney(-5_000)).toBe("$50.00");
  });

  it("keeps the net unsigned, because direction carries that", () => {
    // Deliberately unchanged: net_due_cents is stored positive and the
    // component adds "+"/"-" from `flow`. Signing it here too would print
    // "+-$900.00" for a location being paid.
    const line = describeSettlement(row({ net_due_cents: 90_000 }), "franchise");
    expect(settlementMoney(line.netDueCents)).toBe("$900.00");
  });

  it("the statement component uses the signed formatter for adjustments only", () => {
    const src = read("src/components/FranchiseSettlementStatements.tsx");
    expect(src).toMatch(/adjustments \{settlementSignedMoney\(line\.adjustmentsCents\)\}/);
    expect(src).not.toMatch(/adjustments \{settlementMoney\(line\.adjustmentsCents\)\}/);
    // The net keeps the absolute formatter plus the arrow.
    expect(src).toMatch(/settlementMoney\(line\.netDueCents\)/);
  });
});

describe("the word on the figure matches the arithmetic under it", () => {
  it("does not call the gross 'Revenue', which this page uses for the net", () => {
    const src = read("src/components/FranchiseSettlementStatements.tsx");
    expect(src).toMatch(/Collected revenue \{settlementMoney\(line\.revenueCents\)\}/);
    expect(src).not.toMatch(/[^d] Revenue \{settlementMoney\(line\.revenueCents\)\}/);
  });

  it("agrees with the word the rollup and the rate editor already use", () => {
    // /franchise names franchise_rollup's gross "Collected" and its net
    // "Net revenue MTD"; the rate editor says "% of collected revenue". One
    // vocabulary, or the two screens cannot be reconciled.
    const route = read("src/routes/_authenticated/franchise.tsx");
    expect(route).toMatch(/label="Collected MTD"/);
    expect(route).toMatch(/"Net revenue MTD"/);
    expect(route).toMatch(/% of collected revenue/);
  });
});

describe("the net can be derived from the figures printed beside it", () => {
  it("carries the franchise's share of the collection up from the row", () => {
    const line = describeSettlement(
      row({
        revenue_cents: 1_000_000,
        royalty_percent: "10.00",
        royalty_cents: 100_000,
        revenue_collected_by_parent_cents: 500_000,
        revenue_collected_by_location_cents: 500_000,
        direction: "franchise_owes_location",
        net_due_cents: 400_000,
      }),
      "franchise",
    );
    expect(line.collectedByFranchiseCents).toBe(500_000);
    // net = |collected_by_franchise − royalty − adjustments|
    expect(
      Math.abs(line.collectedByFranchiseCents! - line.royaltyCents - line.adjustmentsCents),
    ).toBe(line.netDueCents);
  });

  it("says null, not zero, when the query did not select the column", () => {
    // The location's own statement list (franchise-membership.functions.ts)
    // still does not select it. Zero would print "the franchise collected
    // $0.00" — a claim — where the truth is "this screen cannot say".
    expect(describeSettlement(row({}), "location").collectedByFranchiseCents).toBeNull();
  });

  it("reports zero as zero when the column WAS selected", () => {
    const line = describeSettlement(row({ revenue_collected_by_parent_cents: 0 }), "franchise");
    expect(line.collectedByFranchiseCents).toBe(0);
  });

  it("the parent's query actually asks for the split", () => {
    // The SELECT LIST, not the prose around it. Slicing to the end of the
    // function matched the comment that explains why the column is there, so
    // deleting the column itself left the assertion green.
    const src = read("src/lib/franchise.functions.ts");
    const from = src.indexOf("export const listRoyaltyInvoices");
    const selects = [...src.slice(from).matchAll(/\.select\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(selects[0], "no .select() found on listRoyaltyInvoices").toBeTruthy();
    expect(selects[0].split(/,\s*/)).toContain("revenue_collected_by_parent_cents");
  });

  it("prints it only when it says something", () => {
    // A location that collects its own money keeps the short sentence it
    // already had; a zero term adds nothing but noise.
    const src = read("src/components/FranchiseSettlementStatements.tsx");
    expect(src).toMatch(/line\.collectedByFranchiseCents !== null &&/);
    expect(src).toMatch(/line\.collectedByFranchiseCents > 0/);
    expect(src).toMatch(/of which the franchise collected/);
  });
});
