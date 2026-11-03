// What one visit is booked for: the plan's price plus the add-ons booked on
// it. A groom's add-ons live on its plan (subscriptions.groom_addons, one row
// per add-on with quantity and unit price) and are charged when the groom is
// completed, so leaving them out understated the day board: "All 3 · $360"
// for a day booked at $410 (R2-31, groom-r2-08).
//
// Still list price, not money collected: no discount, credit or refund is in
// it. The dispatch board labels it that way (IMP-10).

type GroomAddon = { quantity?: unknown; unit_price_cents?: unknown };

function addonCents(addons: unknown): number {
  if (!Array.isArray(addons)) return 0;
  let sum = 0;
  for (const a of addons as GroomAddon[]) {
    const q = Number(a?.quantity);
    const u = Number(a?.unit_price_cents);
    if (Number.isFinite(q) && Number.isFinite(u) && q > 0 && u > 0) sum += Math.round(q * u);
  }
  return sum;
}

/** One visit's booked value in cents, from its plan. */
export function visitBookedCents(
  sub: { price_cents?: number | null; groom_addons?: unknown } | null | undefined,
): number {
  if (!sub) return 0;
  return (sub.price_cents ?? 0) + addonCents(sub.groom_addons);
}

/** The booked value of a set of visits, each read through its plan. */
export function bookedCentsOf(
  visits: ReadonlyArray<{ subscriptions?: Parameters<typeof visitBookedCents>[0] }>,
): number {
  return visits.reduce((sum, v) => sum + visitBookedCents(v.subscriptions), 0);
}
