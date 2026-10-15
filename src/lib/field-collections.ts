// The office's half of a field collection, as arithmetic.
//
// Cash is applied oldest invoice first. Each ticked invoice takes what it is
// owed until the money runs out, and the one where it runs out takes the rest
// and stays open for the remainder (a partial payment). confirm_field_collection
// does exactly this in SQL and records the payments; this is the same rule
// for the card, so what it previews is what happens.
//
// `invoices` must be in the card's order, which is the order the SQL uses:
// period_end, then issued_at, created_at, id (listFieldCollections).

export type OpenInvoice = { id: string; open_cents: number };

/** Oldest first, until the money runs out: $60 against $40, $40, $15 ticks
 *  the first two (the second partly). Invoices with nothing owed are left. */
export function defaultInvoiceSelection(invoices: OpenInvoice[], amountCents: number): string[] {
  let left = amountCents;
  const out: string[] = [];
  for (const inv of invoices) {
    if (left <= 0) break;
    if (inv.open_cents <= 0) continue;
    out.push(inv.id);
    left -= inv.open_cents;
  }
  return out;
}

export type Allocation = { id: string; cents: number; partial: boolean };

/** Where the money goes for a selection, oldest first. `starved` lists ticked
 *  invoices the money never reaches: confirm_field_collection refuses those,
 *  so the card says so before anyone presses Confirm. */
export function allocateOldestFirst(
  invoices: OpenInvoice[],
  selected: string[],
  amountCents: number,
): {
  allocations: Allocation[];
  appliedCents: number;
  unappliedCents: number;
  starved: string[];
} {
  const chosen = new Set(selected);
  let left = amountCents;
  const allocations: Allocation[] = [];
  const starved: string[] = [];
  for (const inv of invoices) {
    if (!chosen.has(inv.id)) continue;
    if (inv.open_cents > 0 && left <= 0) {
      starved.push(inv.id);
      continue;
    }
    const cents = Math.min(left, Math.max(inv.open_cents, 0));
    allocations.push({ id: inv.id, cents, partial: cents < inv.open_cents });
    left -= cents;
  }
  const appliedCents = allocations.reduce((s, a) => s + a.cents, 0);
  return {
    allocations,
    appliedCents,
    unappliedCents: Math.max(amountCents - appliedCents, 0),
    starved,
  };
}
