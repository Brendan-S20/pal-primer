import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  franchiseTrendLines,
  franchiseTrendSeries,
  franchiseTrendWeeks,
  reversalRevenueCents,
  type TrendPayment,
  type TrendReversal,
} from "@/lib/franchise.functions";

// The "Revenue trend: last 8 weeks" chart on /franchise disagreed with the
// table directly underneath it, in two separate ways at once. Both are the
// shape this repo has now fixed three times: one number, more than one
// implementation, and every figure on screen individually plausible.
//
// ── FAULT 1: IT DEDUCTED A DIFFERENT REFUND ────────────────────────────────
//
// A reversal carries TWO figures. `detail.amount_cents` is what MOVED — base
// plus card surcharge, what the customer got back, what reconciles against the
// Stripe dashboard. `detail.revenue_cents` is what comes off INCOME — base
// only, because the surcharge was fee recovery and was never revenue.
//
// `loadOrgReversals` prefers `revenue_cents`. `franchise_rollup` was corrected
// to prefer it on 2026-08-04, by migration
// `20260804080000_the-rollup-and-the-dashboard-netted-refunds-differently`,
// whose header says in as many words that this is "the BUG-21 shape — one
// number with two implementations — reintroduced by fixing only one of them".
// There were three call sites. Two were fixed. This chart was the third, and
// it still read `detail?.amount_cents`.
//
// Both sides subtract their figure from a gross built the same way, out of
// `payments.amount_cents`, which is base only. So for a pass-through location
// with $10,000 collected in a week and one $100 invoice charged as $103 and
// refunded:
//
//     the "Net revenue MTD" table       1000000 - 10000 = $9,900.00
//     the trend line above it            1000000 - 10300 = $9,897.00
//
// Same money, same week, one screen, $3.00 apart.
//
// ── FAULT 2: IT LEFT OUT THE FRANCHISE'S OWN TRUCKS ────────────────────────
//
// The chart drew one line per row of `franchise_children()`, which returns
// CHILDREN only — correctly; it is the membership helper. Every other figure on
// the page comes from `franchise_rollup()`, which includes the parent's own row
// on purpose, "so a rollup reads as the whole franchise rather than 'everyone
// but me'". The stat cards total that row in. The chart never had it.
//
// ── LIVE NUMBERS, measured 2026-08-19 against project vsxzrbxublqrcfnxfwcu ──
//
// One franchise exists: "Demo Pet Waste Co" (342d4d1e…, America/New_York) with
// two locations, Northside (05132407…) and Southside (afaaa8bc…).
//
// Over the exact eight-week window the chart covers, 2026-06-29 → 2026-08-24 UTC,
// counting payments with status IN ('succeeded','refunded'):
//
//     Demo Pet Waste Co (the parent)      372800   $3,728.00   NOT PLOTTED
//     Demo Pet Waste — Northside          332600   $3,326.00   plotted
//     Demo Pet Waste — Southside          334800   $3,348.00   plotted
//     ─────────────────────────────────────────────────────────────────────
//     franchise total                    1040200  $10,402.00
//     what the chart drew                 667400   $6,674.00   64%
//
// The largest single operation in the franchise — larger than either location —
// was missing from the comparison, on the screen whose entire job is comparing
// locations. Month-to-date on the same day the same parent row was $1,526.00 of
// a $5,442.00 franchise total, so the omission is not an artefact of the window.
//
// The refund half could not be measured live: `review_items` holds zero rows of
// kind payment_refunded / payment_chargeback / payment_chargeback_won across
// the whole database, and `franchise_adjustments` is empty. So fault 1 is
// latent in production and is pinned here arithmetically instead.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const PARENT = "342d4d1e-56f7-4b6e-ad40-524d370e1a36";
const NORTH = "05132407-765b-4f41-a98a-0fd8f7068013";

/** A Wednesday, so the week arithmetic has a non-zero Monday offset to get
 *  wrong. Week 8 of the returned window is 2026-08-17 → 2026-08-24. */
const NOW = new Date("2026-08-19T12:00:00.000Z");

const pay = (org: string, cents: number, at: string): TrendPayment => ({
  organization_id: org,
  amount_cents: cents,
  status: "succeeded",
  created_at: at,
});

const reversal = (
  org: string,
  kind: string,
  at: string,
  detail: TrendReversal["detail"],
): TrendReversal => ({ organization_id: org, kind, detected_at: at, detail });

describe("a reversal deducts what came off REVENUE, not what moved", () => {
  it("prefers detail.revenue_cents over detail.amount_cents", () => {
    // $100 invoice charged as $103 with a 3% pass-through surcharge, refunded.
    expect(reversalRevenueCents({ amount_cents: 10300, revenue_cents: 10000 })).toBe(10000);
  });

  it("falls back to amount_cents for a reversal filed before the split", () => {
    // Not decoration: rows filed before `revenue_cents` existed predate
    // pass-through, so the two figures were equal. Without the fallback every
    // historical week would net to zero refunds.
    expect(reversalRevenueCents({ amount_cents: 10300 })).toBe(10300);
    expect(reversalRevenueCents(null)).toBe(0);
  });

  it("nets a surcharged refund out of the week at the same figure the table uses", () => {
    const weeks = franchiseTrendWeeks(NOW);
    const lines = franchiseTrendLines(PARENT, "Demo Pet Waste Co", [
      { id: NORTH, name: "Demo Pet Waste — Northside" },
    ]);
    const series = franchiseTrendSeries(
      lines,
      weeks,
      [pay(NORTH, 1_000_000, "2026-08-18T15:00:00.000Z")],
      [
        reversal(NORTH, "payment_refunded", "2026-08-18T16:00:00.000Z", {
          amount_cents: 10_300,
          revenue_cents: 10_000,
        }),
      ],
    );
    const week = series[series.length - 1];
    // $9,900.00 — what the rollup's own net revenue figure would say. The bug
    // plotted 9897, the surcharge deducted from a base that never included it.
    expect(week[NORTH]).toBe(9_900);
    expect(week[NORTH]).not.toBe(9_897);
  });

  it("adds a won dispute back rather than deducting it twice", () => {
    // Pre-existing and load-bearing, and easy to break while editing the
    // expression above: counting a recovery as a loss moves the line the wrong
    // way by twice the amount.
    const weeks = franchiseTrendWeeks(NOW);
    const lines = franchiseTrendLines(PARENT, "Demo Pet Waste Co", [
      { id: NORTH, name: "Northside" },
    ]);
    const series = franchiseTrendSeries(
      lines,
      weeks,
      [pay(NORTH, 1_000_000, "2026-08-18T15:00:00.000Z")],
      [
        reversal(NORTH, "payment_chargeback", "2026-08-18T16:00:00.000Z", {
          amount_cents: 10_000,
          revenue_cents: 10_000,
        }),
        reversal(NORTH, "payment_chargeback_won", "2026-08-18T17:00:00.000Z", {
          amount_cents: 10_000,
          revenue_cents: 10_000,
        }),
      ],
    );
    expect(series[series.length - 1][NORTH]).toBe(10_000);
  });
});

describe("the chart plots the whole franchise, not everyone but the franchise", () => {
  it("puts the parent's own operation first, before its locations", () => {
    const lines = franchiseTrendLines(PARENT, "Demo Pet Waste Co", [
      { id: NORTH, name: "Demo Pet Waste — Northside" },
    ]);
    expect(lines.map((l) => l.id)).toEqual([PARENT, NORTH]);
    expect(lines[0].name).toBe("Demo Pet Waste Co");
  });

  it("still names the row when the org's name could not be read", () => {
    expect(franchiseTrendLines(PARENT, null, [])[0].name).toBe("This organization");
  });

  it("plots the parent's revenue instead of dropping it on the floor", () => {
    // The live shape: the parent takes more than either location and was the
    // one line missing.
    const weeks = franchiseTrendWeeks(NOW);
    const lines = franchiseTrendLines(PARENT, "Demo Pet Waste Co", [
      { id: NORTH, name: "Demo Pet Waste — Northside" },
    ]);
    const series = franchiseTrendSeries(
      lines,
      weeks,
      [
        pay(PARENT, 372_800, "2026-08-18T15:00:00.000Z"),
        pay(NORTH, 332_600, "2026-08-18T15:00:00.000Z"),
      ],
      [],
    );
    const week = series[series.length - 1];
    expect(week[PARENT]).toBe(3_728);
    expect(week[NORTH]).toBe(3_326);
    // And the sum of the plotted lines is the franchise's total, which is the
    // property that makes the chart reconcile against the stat card above it.
    expect(week[PARENT] + week[NORTH]).toBe(7_054);
  });

  it("the server function hands the same list to the queries and to the legend", () => {
    // The two `.in("organization_id", …)` filters and the returned `locations`
    // all have to be the parent-inclusive list. Fetching the parent's payments
    // and then not drawing them, or drawing a legend entry with no data behind
    // it, are both worse than the original.
    const src = read("src/lib/franchise.functions.ts");
    const handler = src.slice(src.indexOf("export const getFranchiseTrend"));
    const body = handler.slice(0, handler.indexOf("export const markSelfAsFranchiseParent"));
    expect(body).toMatch(/const lines = franchiseTrendLines\(orgId,/);
    expect(body.match(/lines\.map\(\(k\) => k\.id\)/g)?.length).toBe(2);
    expect(body).toMatch(/locations: lines/);
    // `kids` is franchise_children()'s answer and must not be what gets plotted.
    expect(body).not.toMatch(/locations: kids/);
    expect(body).not.toMatch(/kids\.map\(\(k\) => k\.id\)/);
  });
});

describe("the three implementations of one refund figure agree", () => {
  // The drift guard. Each of these is a separate copy of "what a reversal takes
  // off revenue", and the 2026-08-04 migration exists because two of them had
  // already disagreed once.
  it("franchise_rollup prefers revenue_cents in SQL", () => {
    const sql = read(
      "supabase/migrations/20260804080000_the-rollup-and-the-dashboard-netted-refunds-differently.sql",
    );
    expect(sql).toMatch(/COALESCE\(\(ri\.detail->>'revenue_cents'\)::bigint/);
  });

  it("loadOrgReversals prefers revenue_cents in TypeScript", () => {
    expect(read("src/lib/reversals.server.ts")).toMatch(
      /detail\?\.revenue_cents \?\? r\.detail\?\.amount_cents/,
    );
  });

  it("the franchise trend prefers revenue_cents in TypeScript", () => {
    expect(read("src/lib/franchise.functions.ts")).toMatch(
      /detail\?\.revenue_cents \?\? detail\?\.amount_cents/,
    );
  });
});
