// IMP-10 — the one place the app reads REVERSALS from.
//
// A refund or chargeback is recorded twice by the Stripe webhook, on purpose:
//
//   payments.status → 'refunded'   so the charge path knows the money went back
//   review_items     → an entry     so a human is told it happened
//
// Neither of those is a ledger. `payments.status` says what is true TODAY and
// carries no date for the reversal itself, so it cannot answer "how much came
// back in March". The review_items row can: it has `detected_at`, the amount,
// and which payment it belongs to.
//
// So this module reads review_items, and every surface that needs to show
// refunds — the tax pack, /reports, /analytics — reads this module. That is the
// whole point: BUG-21 happened because one number had three implementations,
// and a contra line added independently to three screens would be the same
// mistake with better intentions.
//
// WHY A CONTRA LINE RATHER THAN CORRECTING THE ORIGINAL FIGURE.
//
// Invoice-based revenue (what /reports and /analytics show) counts what was
// BILLED. A refund does not un-bill anything — the invoice was issued, the work
// was done, the money arrived, and later some of it went back. Marking the
// invoice unpaid would be a lie about the past and would silently change every
// historical period the moment a dispute landed.
//
// Showing the reversal as its own dated line keeps both facts true and makes
// the movement visible instead of leaving a figure to quietly shrink. It also
// means /reports and the CPA pack agree, which they must, because an owner will
// hand one to their accountant and read the other over coffee.

import { orgLocalDay, reducesIncome, REVERSAL_KINDS, reversalLabel } from "@/lib/cpa-reports";
import { fetchAllPages } from "@/lib/supabase-paging.server";

export type Reversal = {
  id: string;
  kind: string;
  /** The payment this reversed. May be older than the window being reported. */
  paymentId: string | null;
  /** Org-local calendar day the money moved — never a UTC slice. */
  day: string;
  amountCents: number;
  /** False for a won dispute: the money came back, so it is a recovery rather
   *  than a deduction. Deducting it as well would understate income twice. */
  deducts: boolean;
  typeLabel: string;
};

export type ReversalTotals = {
  /** Refunds and lost/open chargebacks — what comes OFF revenue. Positive. */
  deductedCents: number;
  /** Won disputes — money that came back. Positive. */
  recoveredCents: number;
  /** deducted − recovered: the single figure to subtract from gross. */
  netCents: number;
  count: number;
};

/** UTC bounds wide enough to catch every row whose ORG-LOCAL day falls in the
 *  range. Three days of padding covers every real offset (UTC−12 … UTC+14) in
 *  both directions with room to spare; the exact day filter happens below,
 *  against org-local dates. Over-fetching costs a few rows; under-fetching
 *  loses a refund at a period edge and nobody would ever notice. */
function utcWindow(from: string, to: string) {
  const lo = new Date(`${from}T00:00:00Z`);
  lo.setUTCDate(lo.getUTCDate() - 3);
  const hi = new Date(`${to}T00:00:00Z`);
  hi.setUTCDate(hi.getUTCDate() + 4);
  return { lo: lo.toISOString(), hi: hi.toISOString() };
}

/**
 * Every reversal whose money moved inside [from, to], in the org's own days.
 *
 * `supabase` may be the caller's RLS-bound client — review_items is org-scoped
 * and the caller is a member, so no service-role escalation is needed here.
 */
export async function loadOrgReversals(
  supabase: any,
  opts: { orgId: string; timezone: string; from: string; to: string },
): Promise<Reversal[]> {
  const { orgId, timezone, from, to } = opts;
  const { lo, hi } = utcWindow(from, to);

  const rows = await fetchAllPages<any>((a, b) =>
    supabase
      .from("review_items")
      .select("id, kind, subject_id, detected_at, detail")
      .eq("organization_id", orgId)
      .in("kind", REVERSAL_KINDS as unknown as string[])
      .gte("detected_at", lo)
      .lte("detected_at", hi)
      // `id` is the tiebreaker, not decoration. Paging on a non-unique sort key
      // is undefined between pages, and a webhook backfill files many review
      // items on the same timestamp — so a tie group straddling a page boundary
      // could return one reversal twice or drop it, silently, in the module
      // whose whole job is that the refund figure is right.
      .order("detected_at")
      .order("id")
      .range(a, b),
  );

  return rows
    .map((r) => {
      const day = orgLocalDay(r.detected_at, timezone);
      return {
        id: r.id as string,
        kind: r.kind as string,
        paymentId: (r.subject_id as string | null) ?? null,
        day,
        amountCents: Number(r.detail?.amount_cents ?? 0),
        deducts: reducesIncome(r.kind as string),
        typeLabel: reversalLabel(r.kind as string).type,
      };
    })
    .filter((r) => !!r.day && r.day >= from && r.day <= to);
}

export function totalReversals(rows: Reversal[]): ReversalTotals {
  let deductedCents = 0;
  let recoveredCents = 0;
  for (const r of rows) {
    if (r.deducts) deductedCents += r.amountCents;
    else recoveredCents += r.amountCents;
  }
  return {
    deductedCents,
    recoveredCents,
    netCents: deductedCents - recoveredCents,
    count: rows.length,
  };
}

/** Reversals grouped by the client whose payment they reversed.
 *
 *  The reversal points at a PAYMENT, and that payment can be older than the
 *  window being reported — a March sale refunded in October. Resolving the
 *  customer therefore has to go through the full payment ledger, not through
 *  the period's receipts, or the refund lands under "unattributed" and the
 *  per-client figures stop tying to the total. */
export async function reversalsByClient(
  supabase: any,
  orgId: string,
  rows: Reversal[],
): Promise<Map<string, ReversalTotals>> {
  const byClient = new Map<string, ReversalTotals>();
  const paymentIds = [...new Set(rows.map((r) => r.paymentId).filter(Boolean))] as string[];
  if (paymentIds.length === 0) return byClient;

  const invoiceOfPayment = new Map<string, string>();
  for (let i = 0; i < paymentIds.length; i += 200) {
    const { data } = await supabase
      .from("payments")
      .select("id, invoice_id")
      .eq("organization_id", orgId)
      .in("id", paymentIds.slice(i, i + 200));
    for (const p of data ?? []) invoiceOfPayment.set(p.id, p.invoice_id);
  }

  const invoiceIds = [...new Set([...invoiceOfPayment.values()].filter(Boolean))];
  const clientOfInvoice = new Map<string, string>();
  for (let i = 0; i < invoiceIds.length; i += 200) {
    const { data } = await supabase
      .from("invoices")
      .select("id, client_id")
      .eq("organization_id", orgId)
      .in("id", invoiceIds.slice(i, i + 200));
    for (const inv of data ?? []) clientOfInvoice.set(inv.id, inv.client_id);
  }

  for (const r of rows) {
    const clientId = clientOfInvoice.get(invoiceOfPayment.get(r.paymentId ?? "") ?? "");
    // Deliberately keyed on "" rather than dropped: a reversal we cannot
    // attribute still has to appear somewhere, or the per-client column stops
    // adding up to the total and the sheet looks wrong for no visible reason.
    const key = clientId ?? "";
    const acc = byClient.get(key) ?? {
      deductedCents: 0,
      recoveredCents: 0,
      netCents: 0,
      count: 0,
    };
    if (r.deducts) acc.deductedCents += r.amountCents;
    else acc.recoveredCents += r.amountCents;
    acc.netCents = acc.deductedCents - acc.recoveredCents;
    acc.count += 1;
    byClient.set(key, acc);
  }
  return byClient;
}
