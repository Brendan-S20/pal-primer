// Positional-argument adapters over the authoritative AR math in
// src/lib/ar.ts (I3: one implementation of "overdue" and "amount owed").
// The staff invoice surfaces (drawer, invoices list, client billing tab) and
// the portal server fns call these with (status, due_on) pairs; all money
// math — including net-of-credit balances (B7) — lives in ar.ts.
// Pure functions — unit-tested in tests/overdue.test.ts (I13 #13).

import { invoiceOutstandingCents, isInvoiceOverdue as arIsInvoiceOverdue } from "@/lib/ar";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";

/** Calendar date (YYYY-MM-DD) in the ORGANIZATION's timezone. `due_on` is a
 * date column, so comparisons are lexicographic on ISO date strings.
 *
 * This used to be `new Date().toISOString().slice(0, 10)` — the SERVER's day.
 * For an org in America/Chicago that is already tomorrow from 19:00 local, so
 * every invoice read as overdue five hours before it was due, on its own due
 * date, on the staff invoice list, the drawer, and the customer's own portal.
 *
 * The timezone is optional because these are positional adapters called from a
 * dozen surfaces, and a signature change would silently default the ones not
 * updated. Passing it is what makes the answer right; not passing it falls back
 * to the same default the database uses, which is right for every org today. */
export function todayISO(tz: string = DEFAULT_ORG_TIMEZONE): string {
  return orgToday(tz);
}

/** An invoice is overdue when it is still open and its due date has passed.
 * Paid, void, draft, and written-off invoices are never overdue. */
export function isInvoiceOverdue(
  status: string,
  dueOn: string | null | undefined,
  today: string = todayISO(),
): boolean {
  return arIsInvoiceOverdue({ status, total_cents: null, due_on: dueOn }, today);
}

export type OpenInvoiceSummary = {
  openCount: number;
  openTotalCents: number;
  overdueCount: number;
  /** Soonest due date among open invoices (ISO date), null when none carry one. */
  nextDueOn: string | null;
};

/** Aggregate a client's invoice list into the numbers the portal home card
 * and billing header show: open count, open total (net of applied credit),
 * overdue count. Only status === "open" counts as owed — drafts are quotes,
 * uncollectible is written off, paid/void owe nothing. */
export function summarizeOpenInvoices(
  invoices: Array<{
    status: string;
    total_cents: number | null;
    credit_applied_cents?: number | null;
    amount_paid_cents?: number | null;
    due_on?: string | null;
    deposit_for_invoice_id?: string | null;
  }>,
  today: string = todayISO(),
): OpenInvoiceSummary {
  // A linked stay deposit is part of its stay invoice, which is counted. The
  // portal said "3 open invoices, $1,050" for two stays and a deposit (R2-11).
  const open = invoices.filter((i) => i.status === "open" && !i.deposit_for_invoice_id);
  const dues = open
    .map((i) => i.due_on)
    .filter((d): d is string => !!d)
    .sort();
  return {
    openCount: open.length,
    openTotalCents: open.reduce((s, i) => s + invoiceOutstandingCents(i), 0),
    overdueCount: open.filter((i) => isInvoiceOverdue(i.status, i.due_on, today)).length,
    nextDueOn: dues[0] ?? null,
  };
}
