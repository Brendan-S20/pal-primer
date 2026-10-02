// Expenses: what the business spends, and the arithmetic that has to agree
// with the database to the cent.
//
// Pure, so it can be tested without a browser or a database. The rules that
// matter are stated in 20260929090000_nobody-knew-what-a-route-cost.sql and
// repeated here only where this side has to compute the same answer:
//
//   * A mileage expense is miles x the org's rate, rounded half away from zero,
//     and the rate is the one the row was priced at, not today's. The database
//     computes it and does not believe the client; this computes it so the form
//     can show the same number before it is saved.
//
//   * `spent_on` is a day on the ORGANIZATION's calendar. A receipt from 7pm on
//     31 December in Chicago is a 1 January timestamp in UTC, and filing it by
//     the UTC day moves it into the next tax year.

import { orgLocalDay } from "@/lib/org-day";

export const EXPENSE_CATEGORIES = [
  "fuel",
  "disposal",
  "supplies",
  "equipment",
  "vehicle_maintenance",
  "mileage",
  "other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  fuel: "Fuel",
  disposal: "Disposal fees",
  supplies: "Bags & supplies",
  equipment: "Equipment",
  vehicle_maintenance: "Vehicle maintenance",
  mileage: "Mileage",
  other: "Other",
};

export function isExpenseCategory(v: unknown): v is ExpenseCategory {
  return typeof v === "string" && (EXPENSE_CATEGORIES as readonly string[]).includes(v);
}

/** The IRS standard business mileage rate for 2026, in cents per mile. The
 *  column default in SQL is the same number; an org changes its own rate on
 *  the Expenses page. */
export const IRS_STANDARD_MILEAGE_RATE_CENTS = 76;

/** The largest amount the column accepts: $9,999,999.99. */
export const EXPENSE_AMOUNT_MAX_CENTS = 999_999_999;
export const EXPENSE_MILES_MAX = 100_000;

/**
 * Miles x rate, in whole cents, exactly as Postgres computes
 * `round(miles * mileage_rate_cents)` on numeric(7,1) x numeric(6,2).
 *
 * In INTEGERS, not floats. 12.3 miles at 72.5 cents is 891.75 cents, which
 * rounds to 892; in floating point 12.3 * 72.5 is 891.7499999999999, which
 * rounds to 891, and the form would promise a cent the database does not
 * store. Miles are counted in tenths and the rate in hundredths of a cent, so
 * the product is an exact integer in thousandths of a cent.
 */
export function mileageAmountCents(miles: number, rateCents: number): number {
  if (!Number.isFinite(miles) || !Number.isFinite(rateCents)) return 0;
  const tenths = Math.round(miles * 10);
  const rateHundredths = Math.round(rateCents * 100);
  const thousandths = tenths * rateHundredths;
  const sign = thousandths < 0 ? -1 : 1;
  // Half away from zero, like Postgres's round(numeric).
  return sign * Math.floor((Math.abs(thousandths) + 500) / 1000);
}

/**
 * The rate a mileage row is priced at: the one it already carries, or, for a
 * row becoming a mileage row now, the org's current rate. The same rule as
 * the trigger, so the office's edit form previews what will be stored.
 */
export function mileageRateFor(
  existing: { category: string; mileage_rate_cents: number | string | null } | null,
  orgRateCents: number,
): number {
  if (existing && existing.category === "mileage" && existing.mileage_rate_cents != null) {
    return Number(existing.mileage_rate_cents);
  }
  return orgRateCents;
}

/** "12.3" → 12.3; one decimal place at most, positive, within the column. */
export function parseMiles(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+(\.\d)?$/.test(s)) return null;
  const n = Number(s);
  if (!(n > 0) || n > EXPENSE_MILES_MAX) return null;
  return n;
}

/** "$1,234.56", "1234.5", "45" → cents. Positive, at most two decimals, within
 *  the column. Null otherwise: a refund is not an expense. */
export function parseAmountCents(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > EXPENSE_AMOUNT_MAX_CENTS) return null;
  return cents;
}

/** "72.5" → 72.5 cents per mile. */
export function parseRateCents(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n < 1000 ? n : null;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatExpenseCents(cents: number): string {
  return usd.format((cents || 0) / 100);
}

/** "72.5¢/mi" */
export function formatRate(rateCents: number | string): string {
  return `${Number(Number(rateCents).toFixed(2))}¢/mi`;
}

/** The day an expense logged at `instant` belongs to, on the org's calendar. */
export function expenseDayFor(instant: string | number | Date, tz: string): string {
  return orgLocalDay(instant, tz);
}

/** "2026-09" → first and last day of that month. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

/** Where a receipt is filed: {org}/{staff or "office"}/{expense id}.{ext}.
 *  The storage policies read the first folder as the org and the second as
 *  whose it is. The expense id makes a retry overwrite the same object. */
export function receiptPath(
  orgId: string,
  staffId: string | null | undefined,
  expenseId: string,
  ext: string,
): string {
  const clean = (ext || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  return `${orgId}/${staffId || "office"}/${expenseId}.${clean}`;
}

export type ExpenseRow = {
  id: string;
  spent_on: string;
  category: string;
  amount_cents: number;
  staff_id?: string | null;
};

export type ExpenseSummary = {
  totalCents: number;
  count: number;
  byCategory: Record<ExpenseCategory, number>;
};

function zeroByCategory(): Record<ExpenseCategory, number> {
  return Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, 0])) as Record<
    ExpenseCategory,
    number
  >;
}

/** The totals on the Expenses page, for whatever rows the filters left. */
export function summarizeExpenses(rows: ExpenseRow[]): ExpenseSummary {
  const byCategory = zeroByCategory();
  let totalCents = 0;
  for (const r of rows) {
    const cat: ExpenseCategory = isExpenseCategory(r.category) ? r.category : "other";
    byCategory[cat] += r.amount_cents;
    totalCents += r.amount_cents;
  }
  return { totalCents, count: rows.length, byCategory };
}

/** A month of the accountant's sheet: one column per category. */
export type ExpenseMonth = {
  month: string;
  byCategory: Record<ExpenseCategory, number>;
  totalCents: number;
  count: number;
};

/** One month of the accountant's "Expenses by category, by month" sheet, in
 *  the column keys REPORT_DEFS.expenses_by_category declares. `label` is the
 *  month as a person reads it ("March 2026"), passed in so this file does not
 *  depend on the report module. */
export function expenseReportRow(m: ExpenseMonth, label: string) {
  return {
    month: label,
    fuelCents: m.byCategory.fuel,
    disposalCents: m.byCategory.disposal,
    suppliesCents: m.byCategory.supplies,
    equipmentCents: m.byCategory.equipment,
    vehicleMaintenanceCents: m.byCategory.vehicle_maintenance,
    mileageCents: m.byCategory.mileage,
    otherCents: m.byCategory.other,
    totalCents: m.totalCents,
    expenseCount: m.count,
  };
}

/** The sheet's totals line: every column summed across the months. */
export function expenseReportTotals(months: ExpenseMonth[]) {
  const total: ExpenseMonth = {
    month: "",
    byCategory: zeroByCategory(),
    totalCents: 0,
    count: 0,
  };
  for (const m of months) {
    for (const c of EXPENSE_CATEGORIES) total.byCategory[c] += m.byCategory[c];
    total.totalCents += m.totalCents;
    total.count += m.count;
  }
  return expenseReportRow(total, "Total");
}

/**
 * Expenses by category, by month, between two days inclusive.
 *
 * Every month in the range is a row, zero or not: a gap in a monthly sheet
 * reads as missing data. Rows are placed by `spent_on`, the org-calendar day,
 * and never by when they were written: a receipt logged on the 3rd for fuel
 * bought on the 30th belongs to the month it was bought in.
 */
export function expensesByCategoryByMonth(
  rows: ExpenseRow[],
  from: string,
  to: string,
  months: string[],
): ExpenseMonth[] {
  const out = new Map<string, ExpenseMonth>(
    months.map((m) => [m, { month: m, byCategory: zeroByCategory(), totalCents: 0, count: 0 }]),
  );
  for (const r of rows) {
    const day = (r.spent_on ?? "").slice(0, 10);
    if (!day || day < from || day > to) continue;
    const bucket = out.get(day.slice(0, 7));
    if (!bucket) continue;
    const cat: ExpenseCategory = isExpenseCategory(r.category) ? r.category : "other";
    bucket.byCategory[cat] += r.amount_cents;
    bucket.totalCents += r.amount_cents;
    bucket.count += 1;
  }
  return [...out.values()];
}
