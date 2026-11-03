// Dated payments for the invoices that were paid in more than one go.
//
// A point-in-time balance (outstandingAsOf in ar.ts) has to know WHEN money
// arrived. For an invoice paid in one payment it already does: before
// `paid_at` the whole amount was owed, from it nothing. An invoice paid in
// parts was owed less after each part, and only the payment rows know when.
//
// Loading every payment of every invoice to learn that would be most of the
// ledger for no change in the answer, so this finds the invoices that took a
// partial payment (record_invoice_payment marks one `raw_event.partial`) and
// loads only theirs. The rest keep the one-payment rule.
import type { LedgerInvoice } from "@/lib/ar";

// The same loose client shape invoice-labels.ts takes: callers hold either
// the RLS-bound client or the admin one.
type Db = { from: (table: string) => any };

export async function attachDatedPartialPayments<T extends LedgerInvoice & { id: string }>(
  supabase: Db,
  orgId: string,
  invoices: T[],
): Promise<T[]> {
  const { data: marks, error } = await supabase
    .from("payments")
    .select("invoice_id")
    .eq("organization_id", orgId)
    .eq("status", "succeeded")
    .eq("raw_event->>partial", "true");
  if (error) throw new Error(error.message);
  // A stay invoice is paid in parts whenever its deposit is paid (D3, #653):
  // the deposit's payments sit on the deposit invoice and count toward the
  // stay's. So each such stay invoice is dated from its own payments AND its
  // deposits', whether or not any of them was marked partial.
  const depositsOf = new Map<string, string[]>();
  for (const inv of invoices) {
    const parent = inv.deposit_for_invoice_id;
    if (!parent) continue;
    depositsOf.set(parent, [...(depositsOf.get(parent) ?? []), inv.id]);
  }
  const ids = [
    ...new Set([
      ...((marks ?? []) as Array<{ invoice_id: string }>).map((m) => m.invoice_id),
      ...depositsOf.keys(),
      ...[...depositsOf.values()].flat(),
    ]),
  ];
  if (ids.length === 0) return invoices;

  const byInvoice = new Map<
    string,
    Array<{ amount_cents: number | null; paid_at: string | null }>
  >();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error: pErr } = await supabase
      .from("payments")
      .select("invoice_id, amount_cents, paid_at, created_at")
      .eq("organization_id", orgId)
      .eq("status", "succeeded")
      .in("invoice_id", ids.slice(i, i + 200));
    if (pErr) throw new Error(pErr.message);
    for (const p of (data ?? []) as Array<{
      invoice_id: string;
      amount_cents: number | null;
      paid_at: string | null;
      created_at: string | null;
    }>) {
      const list = byInvoice.get(p.invoice_id) ?? [];
      list.push({ amount_cents: p.amount_cents, paid_at: p.paid_at ?? p.created_at });
      byInvoice.set(p.invoice_id, list);
    }
  }
  for (const inv of invoices) {
    const own = byInvoice.get(inv.id) ?? [];
    const deposits = (depositsOf.get(inv.id) ?? []).flatMap((d) => byInvoice.get(d) ?? []);
    if (deposits.length > 0 || byInvoice.has(inv.id)) inv.paymentsAsOf = [...own, ...deposits];
  }
  return invoices;
}
