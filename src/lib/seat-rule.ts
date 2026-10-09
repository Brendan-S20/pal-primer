// What a seat is, and what Stripe is told about seats. Pure, so it is tested
// without Stripe or a database (tests/seat-rule.test.ts).
//
// ── THE RULE (owner, 2026-10-09) ──────────────────────────────────────────
//
// An "active employee" for billing is ANYONE WHO USED THEIR LOGIN AT LEAST
// ONCE DURING THE BILLING PERIOD, in any role. Somebody on the team who never
// used the app that period costs nothing. Plans include 3 / 10 / 30 (Launch /
// Growth / Scale); each one past that is the plan's per-seat price.
//
// "Used their login" is a sighting recorded while the person is actually in
// the app (staff_seen_days, written by note_staff_seen() from getMyOrg and
// from the offline queue's replay), not auth.users.last_sign_in_at, which a
// silently refreshed session never moves.
//
// ── THE EDGES, DECIDED ────────────────────────────────────────────────────
//
//   * Used the app this period, then deactivated: counts for THIS period, not
//     the next. The count reads the ledger, not staff.active.
//   * A brand-new hire: counts from their first use, for the period it falls
//     in. An invite never accepted costs nothing.
//   * The owner: counts like anybody else.
//   * Impersonation and platform-admin sessions: never a sighting (refused in
//     note_staff_seen()).
//   * The demo org: never billed. syncOrgSeatQuantity skips any org
//     isDemoOrganization() says is demo or comped, before touching Stripe.
//
// ── WHEN THE NUMBER REACHES STRIPE, AND WHICH PERIOD IT PAYS FOR ──────────
//
// The seat line is a LICENSED subscription item: Stripe invoices whatever
// quantity it holds at each renewal. Under the old rule that invoice paid for
// the period about to START (in advance), and every change in between was
// prorated. A count of "people who used it this period" cannot be known in
// advance, so the seat line now runs IN ARREARS:
//
//   during period P   quantity = people seen in P so far, minus the plan's
//                     included seats; only ever rises within P, and every
//                     change is made with proration_behavior "none", so
//                     nothing is charged or credited mid-period;
//   at P's renewal    Stripe invoices that quantity, which by then is
//                     exactly the people who used their login in P;
//   after renewal     the next reconcile drops it to P+1's count so far, still
//                     with no proration.
//
// Stripe prints the renewal's seat line with the dates of the period it opens.
// The money is for the period that just closed. The app says so.
//
// ── THE CHANGEOVER ────────────────────────────────────────────────────────
//
// A subscription billed under the old rule has already paid, in advance, for
// the seats of the period it is in. Billing that period again in arrears at
// its renewal would charge it twice. So a subscription carries a marker in its
// Stripe metadata saying from which period on its seats are in arrears:
//
//   no marker            written by code before this change: the current
//                        period was prepaid. Its seat quantity goes to 0 and
//                        the marker is written with `from` = the current
//                        period's END, so arrears start with the next period.
//   marker, from <= P    P is billed in arrears.
//   marker, from >  P    P was prepaid; quantity 0.
//
// New subscriptions are created with the marker and `from` = "0", and with no
// seat item: their first period's seats are billed at their first renewal.

/** Stripe metadata keys carrying the changeover marker. */
export const SEAT_BILLING_KEY = "seat_billing";
export const SEAT_BILLING_ARREARS = "arrears";
export const SEAT_ARREARS_FROM_KEY = "seat_arrears_from";

/** Epoch seconds, as Stripe reports them. */
export type SubscriptionPeriod = { start: number; end: number };

type MaybeSubscription = {
  current_period_start?: number | null;
  current_period_end?: number | null;
  items?: { data?: Array<{ current_period_start?: number | null; current_period_end?: number | null }> };
};

/**
 * The billing period a subscription is in. On API versions since 2025 the
 * period lives on each item rather than the subscription; every item on one
 * subscription shares a cycle, so the item with the latest end is the one
 * to read. Null when Stripe did not say: a seat count needs a real period,
 * and inventing one would bill the wrong people.
 */
export function subscriptionPeriod(sub: unknown): SubscriptionPeriod | null {
  const s = (sub ?? {}) as MaybeSubscription;
  if (isPositive(s.current_period_start) && isPositive(s.current_period_end)) {
    return { start: s.current_period_start, end: s.current_period_end };
  }
  let best: SubscriptionPeriod | null = null;
  for (const i of s.items?.data ?? []) {
    if (!isPositive(i.current_period_start) || !isPositive(i.current_period_end)) continue;
    if (!best || i.current_period_end > best.end) {
      best = { start: i.current_period_start, end: i.current_period_end };
    }
  }
  return best && best.end > best.start ? best : null;
}

function isPositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Seats past the plan's allowance. Never negative, never fractional. */
export function seatOverage(billableSeats: number, includedSeats: number): number {
  const b = Number.isFinite(billableSeats) ? Math.floor(billableSeats) : 0;
  const i = Number.isFinite(includedSeats) ? Math.floor(includedSeats) : 0;
  return Math.max(0, b - Math.max(0, i));
}

/**
 * From which period start (epoch seconds) this subscription's seats are billed
 * in arrears, or null when it carries no marker (billed under the old rule).
 */
export function arrearsFrom(metadata: Record<string, string> | null | undefined): number | null {
  if (!metadata || metadata[SEAT_BILLING_KEY] !== SEAT_BILLING_ARREARS) return null;
  const from = Number(metadata[SEAT_ARREARS_FROM_KEY]);
  return Number.isFinite(from) && from >= 0 ? from : null;
}

export type SeatTarget = {
  /** The quantity the seat line should hold right now. */
  quantity: number;
  /** True when this period's seats were already paid in advance. */
  prepaid: boolean;
  /** Metadata to write onto the subscription, when it has no marker yet. */
  markWith: Record<string, string> | null;
};

/**
 * What the seat line should hold for this subscription, now.
 *
 * `billableSeats` is the number of people seen since `period.start`
 * (billable_seat_count). `includedSeats` is the plan's allowance.
 */
export function seatTarget(args: {
  period: SubscriptionPeriod;
  metadata: Record<string, string> | null | undefined;
  billableSeats: number;
  includedSeats: number;
}): SeatTarget {
  const from = arrearsFrom(args.metadata);
  if (from === null) {
    // Billed under the old rule: this period's seats were charged at its
    // start. Bill nothing more for it; arrears begin with the next period.
    return {
      quantity: 0,
      prepaid: true,
      markWith: {
        [SEAT_BILLING_KEY]: SEAT_BILLING_ARREARS,
        [SEAT_ARREARS_FROM_KEY]: String(args.period.end),
      },
    };
  }
  if (args.period.start < from) {
    return { quantity: 0, prepaid: true, markWith: null };
  }
  return {
    quantity: seatOverage(args.billableSeats, args.includedSeats),
    prepaid: false,
    markWith: null,
  };
}

/** The marker a brand-new subscription is created with: every period, from
 *  the first, is billed in arrears. */
export function newSubscriptionSeatMarker(): Record<string, string> {
  return { [SEAT_BILLING_KEY]: SEAT_BILLING_ARREARS, [SEAT_ARREARS_FROM_KEY]: "0" };
}

/** Epoch seconds to the ISO string Postgres is handed. */
export function periodBoundaryIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/** The explanation shown wherever the app talks about seats. One sentence,
 *  one place, so billing settings and the plan picker cannot drift apart. */
export const ACTIVE_EMPLOYEE_DEFINITION =
  "An active employee is anyone who used their login this billing period.";
