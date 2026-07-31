// IMP-10 — the query side of the revenue rule.
//
// `revenue.ts` says WHAT counts (money that arrived; reversals deducted where
// they happened). This says how to ASK for it, once, so that the number cannot
// differ between two screens that both claim to show it.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// "How much did we take this month" had three implementations, and they
// disagreed on four separate axes:
//
//   dashboard        paid invoices, dated by ISSUED_AT,  month from the SERVER's clock
//   invoices index   paid invoices, dated by PAID_AT,    month from the BROWSER's UTC
//   reports          paid invoices, dated by ISSUED_AT,  explicit range
//
// So an invoice issued in March and paid in May counted in March on two of
// them and in May on the third. None subtracted applied credit. None could see
// a refund, because a refunded payment leaves the invoice sitting at 'paid'
// forever. And the two month boundaries were computed in whichever timezone
// happened to be running the code — the BUG-12 shape, which for a Chicago org
// means the first five hours of every month land in the previous one.
//
// Three plausible numbers, none of them the amount that reached the bank.
//
// ── WHAT IT COUNTS ─────────────────────────────────────────────────────────
//
// Payments, not invoices. An invoice is a claim; a payment is the money. That
// also makes partial payments, credit application and manual cash entries fall
// out correctly instead of each needing a special case — the payment row says
// what actually moved.
//
// Gross is every payment that ARRIVED, including ones later refunded. The
// reversal is deducted in the period IT happened. Both figures are returned
// alongside the net, because a screen showing only net hands someone a number
// that shrank with nothing to explain it — the exact complaint the review queue
// exists to answer.

import { grossReceivedCents, receivedPaymentStatuses } from "@/lib/revenue";
import { orgLocalDay } from "@/lib/cpa-reports";
import { loadOrgReversals, totalReversals } from "@/lib/reversals.server";

export type CollectedSummary = {
  /** Money that reached the account in the period, before reversals. */
  grossCents: number;
  /** Refunds and lost chargebacks, less recoveries. Can be negative in a
   *  period where more disputes were won than lost. */
  refundsCents: number;
  /** grossCents − refundsCents. The figure to show as "collected". */
  netCents: number;
  paymentCount: number;
  reversalCount: number;
  /** Echoed back so a caller can label the card with the range it actually
   *  measured rather than the one it thinks it asked for. */
  from: string;
  to: string;
  timezone: string;
};

/** The org's own timezone, or a documented fallback.
 *
 *  UTC rather than a guess at a US zone: a wrong offset silently moves money
 *  between periods, and UTC at least fails the same way for everyone and is
 *  explained by the org's own settings page. */
export async function orgTimezone(supabase: any, orgId: string): Promise<string> {
  const { data } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", orgId)
    .maybeSingle();
  return (data as { timezone?: string | null } | null)?.timezone || "UTC";
}

/** Month-to-date, in the ORGANIZATION's calendar.
 *
 *  Not `new Date()` on the server and not `toISOString()` in the browser. Both
 *  were in use, and both put the first hours of a month in the wrong one for
 *  any org west of UTC — on the Dashboard card an owner checks every morning. */
export function monthToDate(timezone: string, now: Date = new Date()) {
  const today = orgLocalDay(now, timezone);
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

/**
 * Money collected in [from, to], in the org's own days.
 *
 * `supabase` may be the caller's RLS-bound client: payments and review_items
 * are both org-scoped and the caller is a member, so nothing here needs
 * service-role.
 */
export async function collectedInPeriod(
  supabase: any,
  opts: { orgId: string; from: string; to: string; timezone?: string },
): Promise<CollectedSummary> {
  const { orgId, from, to } = opts;
  const timezone = opts.timezone ?? (await orgTimezone(supabase, orgId));

  // Padded in UTC, then filtered on the org-local day — the same shape the tax
  // pack uses. Three days covers every real offset in both directions.
  const lo = new Date(`${from}T00:00:00Z`);
  lo.setUTCDate(lo.getUTCDate() - 3);
  const hi = new Date(`${to}T00:00:00Z`);
  hi.setUTCDate(hi.getUTCDate() + 4);

  const PAGE = 1000;
  const rows: Array<{
    amount_cents: number | null;
    status: string;
    paid_at: string | null;
    created_at: string;
  }> = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("payments")
      .select("id, amount_cents, status, paid_at, created_at")
      .eq("organization_id", orgId)
      .in("status", receivedPaymentStatuses())
      .gte("created_at", lo.toISOString())
      .lte("created_at", hi.toISOString())
      // `id` is the tiebreaker, not decoration: a billing batch writes many
      // payments on an identical created_at, and paging on a non-unique sort
      // key is undefined between pages — a tie group straddling a boundary can
      // return a row twice or lose it.
      .order("created_at")
      .order("id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as typeof rows;
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  const inPeriod = rows.filter((p) => {
    // paid_at is when the money moved; created_at is when we wrote the row.
    // They differ for a manually recorded cash payment entered days later, and
    // the money's own date is the one that belongs in a period.
    const day = orgLocalDay(p.paid_at ?? p.created_at, timezone);
    return !!day && day >= from && day <= to;
  });

  const reversals = totalReversals(await loadOrgReversals(supabase, { orgId, timezone, from, to }));

  const grossCents = grossReceivedCents(inPeriod);
  return {
    grossCents,
    refundsCents: reversals.netCents,
    netCents: grossCents - reversals.netCents,
    paymentCount: inPeriod.length,
    reversalCount: reversals.count,
    from,
    to,
    timezone,
  };
}

/** Month-to-date collected, the figure the Dashboard and Invoices cards show. */
export async function collectedMonthToDate(
  supabase: any,
  orgId: string,
): Promise<CollectedSummary> {
  const timezone = await orgTimezone(supabase, orgId);
  const { from, to } = monthToDate(timezone);
  return collectedInPeriod(supabase, { orgId, from, to, timezone });
}
