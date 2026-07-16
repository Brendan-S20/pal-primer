// Ongoing seat-count → Stripe sync for the per-employee plan model (finding #6
// follow-through). Checkout sets the initial seat-overage quantity; this keeps
// it reconciled as active employees come and go.
//
// Truth is read from Stripe (the subscription's own line items) so we never
// depend on organizations.plan_id being maintained: we find whichever base
// price on the subscription maps to a per-employee plan in platform_plans,
// then set the seat-overage item quantity to max(0, activeStaff - included).
//
// Runs with the service role (no user context) and is deliberately best-effort
// at every call site — a Stripe hiccup must never block a staff toggle.

export type SeatSyncResult =
  | { synced: true; quantity: number; changed: boolean }
  | { skipped: string };

const SUB_RE = /^sub_[A-Za-z0-9]{6,}/;

function priceIdOf(item: { price: string | { id: string } }): string {
  return typeof item.price === "string" ? item.price : item.price.id;
}

/**
 * Reconcile the seat-overage subscription item for one org to its current
 * active-employee count. Safe no-op when the org has no live subscription or
 * isn't on a per-employee plan. Never throws for "nothing to do" — only a real
 * Stripe/DB failure propagates (callers wrap in try/catch).
 */
export async function syncOrgSeatQuantity(orgId: string): Promise<SeatSyncResult> {
  const secret = process.env.PLATFORM_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!secret) return { skipped: "stripe_not_configured" };

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("stripe_subscription_id")
    .eq("id", orgId)
    .maybeSingle();
  const subId = (org as any)?.stripe_subscription_id as string | null | undefined;
  if (!subId || !SUB_RE.test(subId) || subId.includes("demo")) return { skipped: "no_subscription" };

  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(secret);
  const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return { skipped: `status_${sub.status}` };

  const priceIds = sub.items.data.map((i) => priceIdOf(i as any));
  if (!priceIds.length) return { skipped: "no_items" };

  // The base price on the subscription tells us which per-employee plan this
  // is — it may be the MONTHLY or the ANNUAL base price, and the seat-overage
  // item must use the matching interval's seat price (Stripe forbids mixing
  // intervals on one subscription). Legacy per-client plans have a null
  // stripe_seat_price_id and are excluded, so they're never touched.
  const idList = `(${priceIds.join(",")})`;
  const { data: plan } = await (supabaseAdmin as any)
    .from("platform_plans")
    .select("included_seats, stripe_seat_price_id, stripe_price_id, stripe_annual_price_id, stripe_annual_seat_price_id")
    .or(`stripe_price_id.in.${idList},stripe_annual_price_id.in.${idList}`)
    .not("stripe_seat_price_id", "is", null)
    .maybeSingle();
  const includedSeats = plan?.included_seats as number | null | undefined;
  const isAnnual =
    !!plan?.stripe_annual_price_id && priceIds.includes(plan.stripe_annual_price_id);
  const seatPriceId = (isAnnual
    ? plan?.stripe_annual_seat_price_id
    : plan?.stripe_seat_price_id) as string | null | undefined;
  if (includedSeats == null || !seatPriceId) return { skipped: "not_per_employee_plan" };

  const { count } = await supabaseAdmin
    .from("staff")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("active", true);
  const overage = Math.max(0, (count ?? 0) - includedSeats);

  const existing = sub.items.data.find((i) => priceIdOf(i as any) === seatPriceId);

  if (overage > 0) {
    if (existing) {
      if ((existing.quantity ?? 0) === overage) return { synced: true, quantity: overage, changed: false };
      await stripe.subscriptionItems.update(existing.id, {
        quantity: overage,
        proration_behavior: "create_prorations",
      });
    } else {
      await stripe.subscriptionItems.create({
        subscription: subId,
        price: seatPriceId,
        quantity: overage,
        proration_behavior: "create_prorations",
      });
    }
    return { synced: true, quantity: overage, changed: true };
  }

  // No overage: remove the seat item if it's still there.
  if (existing) {
    await stripe.subscriptionItems.del(existing.id, { proration_behavior: "create_prorations" });
    return { synced: true, quantity: 0, changed: true };
  }
  return { synced: true, quantity: 0, changed: false };
}
