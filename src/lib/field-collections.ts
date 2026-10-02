// The office's half of a field collection, as arithmetic.
//
// An invoice here is paid whole or not at all -- bulkMarkInvoicesPaid records
// the open balance, and there is no partial payment to record -- so applying
// $40 of cash means choosing open invoices whose balances add up to no more
// than $40. confirm_field_collection refuses any choice that adds up to more;
// this proposes the one the office will usually want.

export type OpenInvoice = { id: string; open_cents: number };

/** Oldest first, every invoice that still fits. Oldest first because that is
 *  the debt the customer was most likely paying, and because it is the order
 *  the list is shown in, so the ticks read top-down. An invoice that does not
 *  fit is skipped, not a reason to stop: $40 against $25, $30, $15 settles the
 *  $25 and the $15. */
export function defaultInvoiceSelection(invoices: OpenInvoice[], amountCents: number): string[] {
  let left = amountCents;
  const out: string[] = [];
  for (const inv of invoices) {
    if (inv.open_cents > 0 && inv.open_cents <= left) {
      out.push(inv.id);
      left -= inv.open_cents;
    }
  }
  return out;
}

/** What a selection applies, and what is left over. */
export function selectionTotals(
  invoices: OpenInvoice[],
  selected: string[],
  amountCents: number,
): { appliedCents: number; unappliedCents: number; overBy: number } {
  const chosen = new Set(selected);
  const applied = invoices.filter((i) => chosen.has(i.id)).reduce((s, i) => s + i.open_cents, 0);
  return {
    appliedCents: applied,
    unappliedCents: Math.max(amountCents - applied, 0),
    overBy: Math.max(applied - amountCents, 0),
  };
}
