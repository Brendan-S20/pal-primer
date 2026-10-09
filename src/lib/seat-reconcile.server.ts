// The backstop that makes the seat line right when Stripe reads it.
//
// The seat line is billed in arrears (seat-rule.ts): Stripe invoices whatever
// quantity it holds AT RENEWAL. A person's first sighting each period already
// asks for a reconcile (seat-sightings.server.ts), but that runs on a Worker's
// waitUntil and is best-effort; one lost to a Stripe hiccup would leave the
// renewal billing a stale number. So once a night, every subscribed org whose
// period ends within the next two days is reconciled again. Two days, not one,
// so a renewal never falls between two nightly runs with neither looking.
//
// Before this, nothing reconciled seats on a schedule at all (see
// tests/a-seat-nobody-was-using-and-everybody-was-paying-for.test.ts).
//
// Never throws: one org's failure is counted and the rest still run.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isDemoOrganization } from "@/lib/demo-org";

/** How far ahead of renewal an org is reconciled. */
export const RECONCILE_AHEAD_MS = 48 * 60 * 60_000;
/** A bound, so a night with a backlog cannot turn into an incident. */
export const RECONCILE_LIMIT = 200;

export type SeatReconcileSummary = {
  considered: number;
  synced: number;
  changed: number;
  failed: number;
  skipped_reasons: Record<string, number>;
};

type OrgRow = {
  id: string;
  slug: string | null;
  is_comped: boolean | null;
  current_period_end: string | null;
};

/** Which orgs tonight's run should look at. Pure, for the test. */
export function dueForSeatReconcile(rows: OrgRow[], now: Date): OrgRow[] {
  const horizon = now.getTime() + RECONCILE_AHEAD_MS;
  return rows.filter((o) => {
    if (isDemoOrganization(o)) return false;
    // A period end we do not know is a renewal we cannot rule out.
    if (!o.current_period_end) return true;
    const end = Date.parse(o.current_period_end);
    return !Number.isFinite(end) || end <= horizon;
  });
}

export async function reconcileSeatsBeforeRenewal(now: Date = new Date()): Promise<SeatReconcileSummary> {
  const summary: SeatReconcileSummary = {
    considered: 0,
    synced: 0,
    changed: 0,
    failed: 0,
    skipped_reasons: {},
  };
  const { data, error } = await (supabaseAdmin as any)
    .from("organizations")
    .select("id, slug, is_comped, current_period_end")
    .not("stripe_subscription_id", "is", null)
    .is("deleted_at", null)
    .limit(5_000);
  if (error) throw new Error(error.message);

  const due = dueForSeatReconcile((data ?? []) as OrgRow[], now);
  if (due.length > RECONCILE_LIMIT) {
    console.warn(`[nightly] ${due.length} orgs due a seat reconcile; doing ${RECONCILE_LIMIT}`);
  }
  const { syncOrgSeatQuantity } = await import("@/lib/seat-sync.server");
  for (const org of due.slice(0, RECONCILE_LIMIT)) {
    summary.considered++;
    try {
      const r = await syncOrgSeatQuantity(org.id);
      if ("skipped" in r) {
        summary.skipped_reasons[r.skipped] = (summary.skipped_reasons[r.skipped] ?? 0) + 1;
      } else {
        summary.synced++;
        if (r.changed) summary.changed++;
      }
    } catch (e) {
      summary.failed++;
      console.error("[nightly] seat reconcile failed", org.id, (e as Error).message);
    }
  }
  return summary;
}
