// Server-side loader for the authoritative platform SaaS metrics. Reads every
// live org + its plan once (platform-admin elevated read, legitimate cross-org)
// and hands the rows to the pure `computePlatformSaasMetrics` so Overview and
// Revenue share one number. Callers must have already asserted platform-admin.

import {
  computePlatformSaasMetrics,
  type OrgForMrr,
  type PlanForMrr,
  type PlatformSaasMetrics,
} from "@/lib/platform-metrics";

export async function fetchPlatformSaasMetrics(
  supabaseAdmin: any,
): Promise<PlatformSaasMetrics> {
  const { data: orgs, error } = await supabaseAdmin
    .from("organizations")
    .select("id, name, billing_status, active_seat_count, plan_id")
    .is("deleted_at", null);
  if (error) throw new Error(error.message);

  const planIds = Array.from(
    new Set((orgs ?? []).map((o: any) => o.plan_id).filter(Boolean)),
  ) as string[];

  const planMap = new Map<string, PlanForMrr>();
  if (planIds.length) {
    const { data: plans, error: pErr } = await supabaseAdmin
      .from("platform_plans")
      .select(
        "id, slug, name, price_cents, annual_price_cents, interval, included_seats, price_per_seat_cents, is_free",
      )
      .in("id", planIds);
    if (pErr) throw new Error(pErr.message);
    for (const p of plans ?? []) {
      planMap.set(p.id, {
        slug: p.slug ?? null,
        name: p.name ?? null,
        price_cents: p.price_cents ?? null,
        annual_price_cents: p.annual_price_cents ?? null,
        interval: p.interval ?? null,
        included_seats: p.included_seats ?? null,
        price_per_seat_cents: p.price_per_seat_cents ?? null,
        is_free: p.is_free ?? null,
      });
    }
  }

  const rows: OrgForMrr[] = (orgs ?? []).map((o: any) => ({
    id: o.id,
    name: o.name,
    billing_status: o.billing_status ?? null,
    active_seat_count: o.active_seat_count ?? null,
    plan: o.plan_id ? planMap.get(o.plan_id) ?? null : null,
  }));

  return computePlatformSaasMetrics(rows);
}
