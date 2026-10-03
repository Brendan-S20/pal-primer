// Churn scoring, run. One path for both buttons that score churn: the
// Clients page (`scoreChurn`, ai-tools.functions.ts) and Analytics
// (`scoreChurnHeuristic`, churn.functions.ts). Until 2026-10-03 they were two
// different scorers with different weights writing the SAME churn_score and
// churn_reason columns, so a client's number depended on which button was
// pressed last. The weights live in churn-score.ts; this gathers the signals
// and saves the result.
import { scoreChurnSignals, type ChurnSignals } from "@/lib/churn-score";

const DAY = 24 * 3600_000;

export async function gatherChurnSignals(
  supabase: any,
  organizationId: string,
  clientId?: string,
): Promise<ChurnSignals[]> {
  // NB: clients has no `status` column — active clients are `active = true`.
  //
  // Paged, all three. These ran unpaged with a 500-client limit, which was
  // the model's batch size, not anything about the business: PostgREST stops
  // at 1000 rows without saying so, and thirty days of visits for a few
  // hundred weekly clients is past that. A visit cut off by the cap is a
  // client scored as "no completed visit in the last 30 days", which is the
  // biggest weight in the score, applied to someone who was visited
  // yesterday (BUG-23, supabase-paging.server.ts).
  const { fetchAllPages } = await import("@/lib/supabase-paging.server");
  const clients = await fetchAllPages<any>((from, to) => {
    let q = supabase
      .from("clients")
      .select("id, display_name, created_at, sms_opt_out, active, autopay_failure_count")
      .eq("organization_id", organizationId)
      .eq("active", true);
    if (clientId) q = q.eq("id", clientId);
    return q.order("id").range(from, to);
  });
  if (!clients.length) return [];

  const ids = new Set<string>(clients.map((c: any) => c.id));
  const now = Date.now();
  const cutoff = new Date(now - 30 * 24 * 3600_000).toISOString();

  // Org-scoped rather than `.in("client_id", ids)`: a few thousand ids in a
  // query string is a URL some proxies refuse, and the org filter selects the
  // same rows. A single-client run narrows to that client.
  const complaintsSince = new Date(now - 90 * DAY).toISOString();
  const [visits, invoices, tickets] = await Promise.all([
    fetchAllPages<any>((from, to) => {
      let q = supabase
        .from("visits")
        .select("id, client_id, status, completed_at, scheduled_on")
        .eq("organization_id", organizationId)
        .gte("scheduled_on", cutoff.slice(0, 10));
      if (clientId) q = q.eq("client_id", clientId);
      return q.order("id").range(from, to);
    }),
    fetchAllPages<any>((from, to) => {
      let q = supabase
        .from("invoices")
        .select("id, client_id, status, total_cents")
        .eq("organization_id", organizationId)
        .in("status", ["open", "uncollectible"]);
      if (clientId) q = q.eq("client_id", clientId);
      return q.order("id").range(from, to);
    }),
    // Concerns and re-clean requests, the signal the Analytics scorer had
    // and this one did not.
    fetchAllPages<any>((from, to) => {
      let q = supabase
        .from("qc_tickets")
        .select("id, client_id, created_at")
        .eq("organization_id", organizationId)
        .gte("created_at", complaintsSince);
      if (clientId) q = q.eq("client_id", clientId);
      return q.order("id").range(from, to);
    }),
  ]);

  const complaintsBy = new Map<string, number>();
  for (const t of tickets) {
    if (!t.client_id || !ids.has(t.client_id)) continue;
    complaintsBy.set(t.client_id, (complaintsBy.get(t.client_id) ?? 0) + 1);
  }

  const visitsBy = new Map<string, any[]>();
  for (const v of visits) {
    if (!ids.has(v.client_id)) continue;
    const list = visitsBy.get(v.client_id) ?? [];
    list.push(v);
    visitsBy.set(v.client_id, list);
  }
  const invoicesBy = new Map<string, any[]>();
  for (const i of invoices) {
    if (!ids.has(i.client_id)) continue;
    const list = invoicesBy.get(i.client_id) ?? [];
    list.push(i);
    invoicesBy.set(i.client_id, list);
  }

  return clients.map((c: any) => {
    const cVisits = visitsBy.get(c.id) ?? [];
    const completed = cVisits.filter((v: any) => v.status === "completed");
    const skipped = cVisits.filter((v: any) => v.status === "skipped");
    const lastCompleted = completed
      .map((v: any) => (v.completed_at ? new Date(v.completed_at).getTime() : 0))
      .reduce((a: number, b: number) => Math.max(a, b), 0);
    const cInvs = invoicesBy.get(c.id) ?? [];
    return {
      client_id: c.id,
      display_name: c.display_name,
      tenure_days: Math.floor((now - new Date(c.created_at).getTime()) / 86400000),
      days_since_last_visit: lastCompleted ? Math.floor((now - lastCompleted) / 86400000) : null,
      completed_last_30: completed.length,
      skipped_last_30: skipped.length,
      unpaid_invoice_count: cInvs.length,
      unpaid_total_cents: cInvs.reduce((s: number, i: any) => s + (i.total_cents ?? 0), 0),
      sms_opt_out: !!c.sms_opt_out,
      complaints_last_90: complaintsBy.get(c.id) ?? 0,
      autopay_failures: c.autopay_failure_count ?? 0,
    };
  });
}

/** Gather, score and save. Returns how many clients were scored. */
export async function runChurnScoring(
  supabase: any,
  organizationId: string,
  clientId?: string,
): Promise<{ scored: number }> {
  const signals = await gatherChurnSignals(supabase, organizationId, clientId);
  if (!signals.length) return { scored: 0 };

  const scoredAt = new Date().toISOString();
  const rows = signals.map((s) => ({ client_id: s.client_id, ...scoreChurnSignals(s) }));

  // In batches rather than one at a time: an org can have thousands of
  // clients, and a round trip each, in series, is minutes.
  const BATCH = 25;
  for (let i = 0; i < rows.length; i += BATCH) {
    await Promise.all(
      rows.slice(i, i + BATCH).map((r) =>
        supabase
          .from("clients")
          .update({ churn_score: r.score, churn_reason: r.reason, churn_scored_at: scoredAt })
          .eq("id", r.client_id)
          .eq("organization_id", organizationId),
      ),
    );
  }
  return { scored: rows.length };
}

