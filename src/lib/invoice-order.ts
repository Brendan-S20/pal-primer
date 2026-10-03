import { isInvoiceOverdue } from "@/lib/overdue";

// ── ON A PHONE, THE INVOICES THAT NEED SOMETHING COME FIRST ──────────────
//
// The invoice list is newest first, which at a desk is right: the table has
// columns, a status filter and room to scan. On a phone it is one card per
// screen-third, and newest first put this month's paid invoices above last
// month's overdue one, so the invoice that needed a phone call was three
// scrolls down (launch pass, 2026-10, recommendation 9).
//
// So the phone's cards are ordered by what the invoice needs from you:
//
//   0  overdue           chase it
//   1  open, not yet due  waiting on the client
//   2  draft             not sent yet
//   3  uncollectible     written off, kept for the record
//   4  paid
//   5  void
//
// and newest first within each, which is the order the list arrives in (the
// sort is stable). Overdue is the org's own day, through the one definition
// in src/lib/ar.ts, so a card cannot say "Overdue" and sort as merely open.

const RANK: Record<string, number> = {
  open: 1,
  draft: 2,
  uncollectible: 3,
  paid: 4,
  void: 5,
};

export function invoiceActionRank(
  inv: { status: string; due_on?: string | null },
  today: string,
): number {
  if (isInvoiceOverdue(inv.status, inv.due_on, today)) return 0;
  return RANK[inv.status] ?? 3;
}

/** Most actionable first, keeping the incoming order within each group. */
export function byWhatNeedsDoing<T extends { status: string; due_on?: string | null }>(
  invoices: readonly T[],
  today: string,
): T[] {
  return invoices
    .map((inv, i) => ({ inv, i, rank: invoiceActionRank(inv, today) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.inv);
}
