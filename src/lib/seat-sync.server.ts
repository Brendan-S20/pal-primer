import { makeStripe } from "@/lib/stripe-client.server";
import { planLookupKey } from "@/lib/stripe-lookup-keys";
import {
  loadPriceCatalog,
  resolvePriceId,
  resolvePriceIdSet,
} from "@/lib/stripe-price-catalog.server";
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

  const stripe = await makeStripe(secret);
  const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return { skipped: `status_${sub.status}` };

  const priceIds = sub.items.data.map((i) => priceIdOf(i as any));
  if (!priceIds.length) return { skipped: "no_items" };

  // The base price on the subscription tells us which per-employee plan this
  // is — it may be the MONTHLY or the ANNUAL base price, and the seat-overage
  // item must use the matching interval's seat price (Stripe forbids mixing
  // intervals on one subscription). Legacy per-client plans have a null
  // stripe_seat_price_id and are excluded, so they're never touched.
  //
  // Matching is done through the price CATALOG rather than by asking the
  // database for a row whose stored id equals one on the subscription. Every
  // stored id is a live id, so under a test key that query matched nothing and
  // this returned `not_per_employee_plan` — a silent no-op that looks exactly
  // like a legacy per-client plan. Checkout would set the initial seat quantity
  // and then nothing would ever reconcile it again. Resolving by lookup key
  // finds the plan in whichever account the subscription actually lives in;
  // the stored ids stay in each set so a live subscription created before the
  // keys existed still matches.
  const catalog = await loadPriceCatalog(stripe);
  const { data: planRows } = await (supabaseAdmin as any)
    .from("platform_plans")
    .select("slug, included_seats, stripe_seat_price_id, stripe_price_id, stripe_annual_price_id, stripe_annual_seat_price_id");

  let includedSeats: number | null | undefined;
  // Two different questions, and they need different strictness.
  //
  //   `seatItemIds` — which item on this subscription IS the seat line. A
  //   membership test, so the stored id counts even if the account no longer
  //   lists the price: a seat price archived in Stripe while a subscription
  //   still bills on it must not freeze that org's seat reconciliation.
  //
  //   `seatPriceToCreate` — the id to hand Stripe for a NEW item, which has to
  //   be a price this account actually has. Sending anything else is an error
  //   at the API, so null here means "cannot add a seat line", not "use it
  //   anyway and find out".
  let seatItemIds: Set<string> = new Set();
  let seatPriceToCreate: string | null = null;
  for (const p of ((planRows ?? []) as any[])) {
    // A legacy per-client plan has no seat price at all and must never be
    // touched — same exclusion the `.not(...is null)` filter used to make.
    if (!p.stripe_seat_price_id) continue;
    const slug = p.slug as string | null;
    const baseIds = (kind: "base_monthly" | "base_annual", stored: string | null) =>
      resolvePriceIdSet(catalog, slug ? [planLookupKey(slug, kind)] : [], [stored]);

    const monthlyBase = baseIds("base_monthly", p.stripe_price_id);
    const annualBase = baseIds("base_annual", p.stripe_annual_price_id);
    const onAnnual = priceIds.some((id) => annualBase.has(id));
    const onMonthly = priceIds.some((id) => monthlyBase.has(id));
    if (!onAnnual && !onMonthly) continue;

    includedSeats = p.included_seats;
    // Stripe forbids mixing month and year items on one subscription, so the
    // seat item has to take the interval the base item is already on.
    const seatKind = onAnnual ? "seat_annual" : "seat_monthly";
    const storedSeat = onAnnual ? p.stripe_annual_seat_price_id : p.stripe_seat_price_id;
    seatItemIds = resolvePriceIdSet(
      catalog,
      slug ? [planLookupKey(slug, seatKind)] : [],
      [storedSeat],
    );
    seatPriceToCreate = resolvePriceId(
      catalog,
      planLookupKey(slug ?? "", seatKind),
      storedSeat,
    );
    break;
  }
  if (includedSeats == null || seatItemIds.size === 0) return { skipped: "not_per_employee_plan" };

  const { count } = await supabaseAdmin
    .from("staff")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("active", true);
  const overage = Math.max(0, (count ?? 0) - includedSeats);

  const existing = sub.items.data.find((i) => seatItemIds.has(priceIdOf(i as any)));

  if (overage > 0) {
    if (existing) {
      if ((existing.quantity ?? 0) === overage) return { synced: true, quantity: overage, changed: false };
      await stripe.subscriptionItems.update(existing.id, {
        quantity: overage,
        proration_behavior: "create_prorations",
      });
    } else {
      // Nothing to add the seats to and no price in this account to mint one
      // from. Better to report it than to send Stripe an id it will reject.
      if (!seatPriceToCreate) return { skipped: "seat_price_not_in_account" };
      await stripe.subscriptionItems.create({
        subscription: subId,
        price: seatPriceToCreate,
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
