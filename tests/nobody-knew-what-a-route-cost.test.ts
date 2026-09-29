// Nobody knew what a route cost.
//
// The arithmetic behind expenses, pinned: what a mileage trip is worth, which
// rate it is worth it at, and which month (and at year end, which tax year) an
// expense is filed in. Each case is stated as the number a person would expect
// to see on the page or on the accountant's sheet.
//
// The rules the DATABASE enforces are proved in a real Postgres by
// a-tech-sees-only-their-own-expenses.test.ts. What is here is the half the
// browser computes, which has to agree with it to the cent.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPENSE_CATEGORIES,
  IRS_STANDARD_MILEAGE_RATE_CENTS,
  expenseDayFor,
  expenseReportRow,
  expenseReportTotals,
  expensesByCategoryByMonth,
  formatRate,
  mileageAmountCents,
  mileageRateFor,
  monthBounds,
  parseAmountCents,
  parseMiles,
  parseRateCents,
  receiptPath,
  summarizeExpenses,
  type ExpenseRow,
} from "@/lib/expenses";
import { REPORT_DEFS, REPORT_ORDER, monthLabel, monthsBetween } from "@/lib/cpa-reports";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION = read("supabase/migrations/20260929090000_nobody-knew-what-a-route-cost.sql");

describe("a mileage trip is miles times the rate, to the cent the database stores", () => {
  it("rounds half away from zero, in integers, where floating point would lose the cent", () => {
    // 64.6 miles at 62.5 cents (the IRS rate for the second half of 2022) is
    // 4037.5 exactly, which Postgres's round(numeric) makes 4038. In floating
    // point 64.6 * 62.5 is 4037.4999999999995 and Math.round gives 4037: the
    // form would show a cent the database never stores. Found by searching
    // every tenth of a mile to 200 at six real IRS rates for a disagreement.
    expect(64.6 * 62.5).toBeLessThan(4037.5);
    expect(Math.round(64.6 * 62.5)).toBe(4037);
    expect(mileageAmountCents(64.6, 62.5)).toBe(4038);
    expect(mileageAmountCents(128.2, 62.5)).toBe(8013);
    // 12.3 x 72.5 = 891.75: the half cent at today's rate goes up.
    expect(mileageAmountCents(12.3, 72.5)).toBe(892);
  });

  it("prices the everyday trips", () => {
    expect(mileageAmountCents(10, 72.5)).toBe(725);
    expect(mileageAmountCents(23.4, 72.5)).toBe(1697); // 1696.5 -> 1697
    expect(mileageAmountCents(0.1, 72.5)).toBe(7); // 7.25 -> 7
    expect(mileageAmountCents(1, 65.5)).toBe(66); // 65.5 -> 66, the 2023 rate
    expect(mileageAmountCents(100000, 999.99)).toBe(99_999_000);
  });

  it("defaults to the IRS standard business rate", () => {
    expect(IRS_STANDARD_MILEAGE_RATE_CENTS).toBe(72.5);
    // The SQL default is the same number, or a new org would preview one rate
    // and be charged another.
    expect(MIGRATION).toMatch(/mileage_rate_cents numeric\(6,2\) NOT NULL DEFAULT 72\.50/);
    expect(formatRate(72.5)).toBe("72.5¢/mi");
    expect(formatRate("70.00")).toBe("70¢/mi");
  });
});

describe("the rate a trip is priced at is the one it was logged at", () => {
  it("keeps a logged trip's own rate when the org's rate has moved on", () => {
    // Logged last March at 72.5; the org has since set 80. Editing the miles
    // must not reprice the trip at 80.
    expect(mileageRateFor({ category: "mileage", mileage_rate_cents: "72.50" }, 80)).toBe(72.5);
  });

  it("takes the org's current rate for a new trip, or a row that becomes one", () => {
    expect(mileageRateFor(null, 80)).toBe(80);
    expect(mileageRateFor({ category: "fuel", mileage_rate_cents: null }, 80)).toBe(80);
  });

  it("is the same rule the database trigger applies", () => {
    // The trigger snapshots the org's rate only when the row BECOMES mileage,
    // and otherwise carries OLD's rate forward whatever the payload said.
    expect(MIGRATION).toMatch(
      /IF TG_OP = 'INSERT' OR OLD\.category IS DISTINCT FROM 'mileage' THEN\s+SELECT o\.mileage_rate_cents INTO NEW\.mileage_rate_cents/,
    );
    expect(MIGRATION).toMatch(/ELSE\s+NEW\.mileage_rate_cents := OLD\.mileage_rate_cents;/);
    expect(MIGRATION).toMatch(
      /NEW\.amount_cents := round\(NEW\.miles \* NEW\.mileage_rate_cents\)::integer;/,
    );
    // And a CHECK, so no path at all -- a service-role script included -- can
    // store a mileage row that does not add up.
    expect(MIGRATION).toMatch(
      /CONSTRAINT expenses_mileage_adds_up CHECK \(\s*category <> 'mileage' OR amount_cents = round\(miles \* mileage_rate_cents\)::integer/,
    );
  });
});

describe("what a person types", () => {
  it("reads an amount as cents, positive, two decimals at most", () => {
    expect(parseAmountCents("45")).toBe(4500);
    expect(parseAmountCents("$1,234,567.89")).toBe(123_456_789);
    expect(parseAmountCents("0.07")).toBe(7);
    expect(parseAmountCents("19.9")).toBe(1990);
    for (const bad of ["", "0", "-5", "1.234", "abc", "10000000.00"]) {
      expect(parseAmountCents(bad), bad).toBeNull();
    }
  });

  it("reads miles to one decimal place and a rate to two", () => {
    expect(parseMiles("12.3")).toBe(12.3);
    expect(parseMiles("12.34")).toBeNull();
    expect(parseMiles("0")).toBeNull();
    expect(parseRateCents("72.5")).toBe(72.5);
    expect(parseRateCents("0")).toBeNull();
    expect(parseRateCents("1000")).toBeNull();
  });

  it("files a receipt under the org, then the person, then the expense", () => {
    expect(receiptPath("org", "staff", "exp", "JPG")).toBe("org/staff/exp.jpg");
    expect(receiptPath("org", null, "exp", "pdf")).toBe("org/office/exp.pdf");
    expect(receiptPath("org", "staff", "exp", "")).toBe("org/staff/exp.jpg");
  });
});

// ── the month an expense belongs to ────────────────────────────────────────

const CHI = "America/Chicago";
const row = (id: string, spent_on: string, category: string, amount_cents: number): ExpenseRow => ({
  id,
  spent_on,
  category,
  amount_cents,
});

describe("an expense is dated on the org's calendar", () => {
  it("keeps a New Year's Eve fuel stop in the year it was bought", () => {
    // 7pm on 31 December in Chicago is 1 January in UTC. Logged from the
    // field at that moment, it is December's fuel and last year's deduction.
    expect(expenseDayFor("2027-01-01T01:00:00Z", CHI)).toBe("2026-12-31");
    expect(expenseDayFor("2027-01-01T14:00:00Z", CHI)).toBe("2027-01-01");
  });

  it("knows the last day of every month", () => {
    expect(monthBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthBounds("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthBounds("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});

describe("Expenses by category, by month", () => {
  const rows = [
    row("a", "2026-01-03", "fuel", 4567),
    row("b", "2026-01-31", "fuel", 1000),
    row("c", "2026-01-31", "disposal", 2500),
    row("d", "2026-03-01", "mileage", 892),
    row("e", "2026-03-15", "vehicle_maintenance", 123_456_789),
    row("f", "2026-03-15", "something-new", 50), // an unknown category is Other, never lost
    row("g", "2025-12-31", "fuel", 9999), // New Year's Eve: last year, out of range
    row("h", "2026-04-01", "fuel", 9999), // the day after the period
  ];
  const months = expensesByCategoryByMonth(
    rows,
    "2026-01-01",
    "2026-03-31",
    monthsBetween("2026-01-01", "2026-03-31"),
  );

  it("has a row for every month, including the one with nothing in it", () => {
    expect(months.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(months[1].totalCents).toBe(0);
    expect(months[1].count).toBe(0);
  });

  it("sums each category into the month of its day, and nothing from outside the period", () => {
    expect(months[0].byCategory.fuel).toBe(5567);
    expect(months[0].byCategory.disposal).toBe(2500);
    expect(months[0].totalCents).toBe(8067);
    expect(months[0].count).toBe(3);
    expect(months[2].byCategory.mileage).toBe(892);
    expect(months[2].byCategory.vehicle_maintenance).toBe(123_456_789);
    expect(months[2].byCategory.other).toBe(50);
    expect(months[2].totalCents).toBe(123_456_789 + 892 + 50);
  });

  it("adds across to the total and down to the totals line", () => {
    for (const m of months) {
      const across = EXPENSE_CATEGORIES.reduce((n, c) => n + m.byCategory[c], 0);
      expect(across).toBe(m.totalCents);
    }
    const totals = expenseReportTotals(months);
    expect(totals.month).toBe("Total");
    expect(totals.fuelCents).toBe(5567);
    expect(totals.totalCents).toBe(months.reduce((n, m) => n + m.totalCents, 0));
    expect(totals.expenseCount).toBe(6);
    // And the page's own totals agree with the sheet's for the same rows.
    const inPeriod = rows.filter((r) => r.spent_on >= "2026-01-01" && r.spent_on <= "2026-03-31");
    expect(summarizeExpenses(inPeriod).totalCents).toBe(totals.totalCents);
  });

  it("names every column the report declares, and no other", () => {
    const def = REPORT_DEFS.expenses_by_category;
    expect(REPORT_ORDER).toContain("expenses_by_category");
    const r = expenseReportRow(months[0], monthLabel(months[0].month));
    expect(Object.keys(r).sort()).toEqual(def.columns.map((c) => c.key).sort());
    expect(r.month).toBe("January 2026");
    expect(def.basis).toBe("cash");
  });
});

describe("the accountant's pack says what it covers", () => {
  const fns = read("src/lib/cpa-reports.functions.ts");

  it("no longer says expenses are not tracked at all", () => {
    expect(fns).not.toMatch(/"Expenses are not tracked\. These reports cover income/);
  });

  it("still says payroll and Stripe's fees are not tracked", () => {
    const gap = /"Expenses are tracked[^"]*"/.exec(fns)?.[0] ?? "";
    expect(gap, "the expenses gap line is missing").not.toBe("");
    expect(gap).toMatch(/Payroll/);
    expect(gap).toMatch(/Stripe's processing fees are not tracked/);
  });

  it("builds the sheet from spent_on, the org-calendar day", () => {
    expect(fns).toMatch(/case "expenses_by_category":\s+built = await buildExpensesByCategory/);
    expect(fns).toMatch(/\.gte\("spent_on", from\)\s+\.lte\("spent_on", to\)/);
  });
});
