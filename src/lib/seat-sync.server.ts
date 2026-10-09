import { makeStripe } from "@/lib/stripe-client.server";
import { planLookupKey } from "@/lib/stripe-lookup-keys";
import {
  loadPriceCatalog,
  resolvePriceId,
  resolvePriceIdSet,
} from "@/lib/stripe-price-catalog.server";
import { isDemoOrganization } from "@/lib/demo-org";
import { periodBoundaryIso, seatTarget, subscriptionPeriod } from "@/lib/seat-rule";
// Seat-count → Stripe sync for the per-employee plan model.
//
// WHAT A SEAT IS, AND WHICH PERIOD THE NUMBER PAYS FOR, is written down in
// `seat-rule.ts` and nowhere else; read that first. In one line: a seat is
// anybody who used their login during the billing period, and the seat line
// is billed in ARREARS -- it holds "people seen this period so far, past the
// allowance", changed with no proration, and Stripe invoices it at renewal.
//
// It used to count `staff.active = true` at the moment this ran, prorated
// every change, and was billed in advance: a snapshot that charged for people
// who never opened the app and missed somebody who worked half the period and
// left.
//
// Truth about the PLAN and the PERIOD is read from Stripe (the subscription's
// own line items and dates) so we never depend on organizations.plan_id being
// maintained: we find whichever base price on the subscription maps to a
// per-employee plan in platform_plans. Truth about WHO WAS SEEN is read from
// the staff_seen_days ledger through billable_seat_count().
//
// Called from: setStaffActive and resyncMySeats (users.functions.ts),
// refreshBillingStatus (billing.functions.ts), a person's first sighting in
// the period (seat-sightings.server.ts), and the nightly run for every org
// within two days of renewal (seat-reconcile.server.ts).
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
 * Reconcile the seat-overage subscription item for one org to the people who
 * have used their login this billing period. Safe no-op when the org has no
 * live subscription, isn't on a per-employee plan, or is the demo org. Never
 * throws for "nothing to do" — only a real Stripe/DB failure propagates
 * (callers wrap in try/catch).
 */
export async function syncOrgSeatQuantity(orgId: string): Promise<SeatSyncResult> {
  const secret = process.env.PLATFORM_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!secret) return { skipped: "stripe_not_configured" };

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("stripe_subscription_id, slug, is_comped")
    .eq("id", orgId)
    .maybeSingle();
  // The demo org (and any comped org -- one definition, demo-org.ts) is never
  // billed for seats, whatever its subscription id looks like.
  if (isDemoOrganization(org as { slug?: string | null; is_comped?: boolean | null } | null)) {
    return { skipped: "demo_org" };
  }
  const subId = (org as any)?.stripe_subscription_id as string | null | undefined;
  if (!subId || !SUB_RE.test(subId) || subId.includes("demo")) return { skipped: "no_subscription" };

  const stripe = await makeStripe(secret);
  const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return { skipped: `status_${sub.status}` };

  // The count is "people seen since this period began", so without a period
  // there is no count. Guessing one would bill the wrong people.
  const period = subscriptionPeriod(sub);
  if (!period) return { skipped: "no_period" };

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

  const billable = await billableSeatsSince(supabaseAdmin, orgId, period.start);

  if (includedSeats == null || seatItemIds.size === 0) {
    // Recorded anyway: a sighting checks this row before asking for a
    // reconcile, and without it every person's first visit each day would
    // send this org's subscription back to Stripe to learn the same thing.
    await recordSeatPeriod(supabaseAdmin, orgId, period, billable, null);
    return { skipped: "not_per_employee_plan" };
  }

  const target = seatTarget({
    period,
    metadata: (sub.metadata ?? {}) as Record<string, string>,
    billableSeats: billable,
    includedSeats,
  });
  // A subscription from before this change: say on the subscription itself
  // that its seats are in arrears from the next period. Stripe merges
  // metadata keys, so nothing else on it is touched.
  if (target.markWith) {
    await stripe.subscriptions.update(subId, { metadata: target.markWith });
  }
  const overage = target.quantity;

  const existing = sub.items.data.find((i) => seatItemIds.has(priceIdOf(i as any)));

  // proration_behavior "none" on every change, both directions. In arrears the
  // quantity is only invoiced at renewal; a proration would charge (or credit)
  // a fraction of a seat now for a period the renewal is about to bill whole.
  let result: SeatSyncResult;
  if (overage > 0) {
    if (existing) {
      if ((existing.quantity ?? 0) === overage) {
        result = { synced: true, quantity: overage, changed: false };
      } else {
        await stripe.subscriptionItems.update(existing.id, {
          quantity: overage,
          proration_behavior: "none",
        });
        result = { synced: true, quantity: overage, changed: true };
      }
    } else {
      // Nothing to add the seats to and no price in this account to mint one
      // from. Better to report it than to send Stripe an id it will reject.
      if (!seatPriceToCreate) return { skipped: "seat_price_not_in_account" };
      await stripe.subscriptionItems.create({
        subscription: subId,
        price: seatPriceToCreate,
        quantity: overage,
        proration_behavior: "none",
      });
      result = { synced: true, quantity: overage, changed: true };
    }
  } else if (existing) {
    // No overage: remove the seat item if it's still there.
    await stripe.subscriptionItems.del(existing.id, { proration_behavior: "none" });
    result = { synced: true, quantity: 0, changed: true };
  } else {
    result = { synced: true, quantity: 0, changed: false };
  }

  await recordSeatPeriod(supabaseAdmin, orgId, period, billable, overage);
  return result;
}

/** People seen in the org since the period began (staff_seen_days). */
async function billableSeatsSince(admin: unknown, orgId: string, periodStart: number): Promise<number> {
  const { data, error } = await (admin as any).rpc("billable_seat_count", {
    _org_id: orgId,
    _since: periodBoundaryIso(periodStart),
  });
  // A failed count must not be read as zero: zero would remove the seat
  // line and the renewal would bill nobody. Throw, and the caller's
  // best-effort catch reports `failed`.
  if (error) throw new Error(`billable_seat_count: ${error.message}`);
  const n = Number(data);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Remember which period the seat line was reconciled for. Best-effort: the
 * Stripe quantity is already right, and this row only decides how soon the
 * next sighting asks for another reconcile.
 */
async function recordSeatPeriod(
  admin: unknown,
  orgId: string,
  period: { start: number; end: number },
  billable: number,
  quantity: number | null,
): Promise<void> {
  try {
    const { error } = await (admin as any).from("org_seat_periods").upsert(
      {
        organization_id: orgId,
        period_start: periodBoundaryIso(period.start),
        period_end: periodBoundaryIso(period.end),
        billable_seats: billable,
        seat_quantity: quantity,
        synced_at: new Date().toISOString(),
      },
      { onConflict: "organization_id" },
    );
    if (error) console.error("org_seat_periods write failed", orgId, error.message);
  } catch (e) {
    console.error("org_seat_periods write failed", orgId, (e as Error).message);
  }
}
