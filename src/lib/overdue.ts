// Positional-argument adapters over the authoritative AR math in
// src/lib/ar.ts (I3: one implementation of "overdue" and "amount owed").
// The staff invoice surfaces (drawer, invoices list, client billing tab) and
// the portal server fns call these with (status, due_on) pairs; all money
// math — including net-of-credit balances (B7) — lives in ar.ts.
// Pure functions — unit-tested in tests/overdue.test.ts (I13 #13).

import {
  invoiceOutstandingCents,
  isInvoiceOverdue as arIsInvoiceOverdue,
} from "@/lib/ar";

/** Local calendar date (YYYY-MM-DD). due_on is a date column, so comparisons
 * are lexicographic on ISO date strings. */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
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
    due_on?: string | null;
  }>,
  today: string = todayISO(),
): OpenInvoiceSummary {
  const open = invoices.filter((i) => i.status === "open");
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
