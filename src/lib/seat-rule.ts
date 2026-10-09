// What a seat is, and how it is charged. Pure, so it is tested without
// Stripe or a database (tests/seat-rule.test.ts). The Stripe side is
// seat-charges.server.ts; the database side is
// supabase/migrations/20261009130000_a-seat-is-somebody-who-showed-up.sql.
//
// ── THE RULE (owner, 2026-10-09) ──────────────────────────────────────────
//
// An "active employee" for billing is ANYONE WHO USED THEIR LOGIN AT LEAST
// ONCE DURING THE BILLING PERIOD, in any role. Somebody on the team who never
// used the app that period costs nothing. Plans include 3 / 10 / 30 (Launch /
// Growth / Scale); each one past that is the plan's per-seat price ($10).
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
//     in, as one whole seat. An invite never accepted costs nothing.
//   * The owner: counts like anybody else.
//   * Impersonation and platform-admin sessions: never a sighting (refused in
//     note_staff_seen()).
//   * The demo org, and every comped org: never charged.
//
// ── HOW IT IS CHARGED (owner, 2026-10-09) ─────────────────────────────────
//
//   1. A SEAT PERIOD IS ONE MONTH, on monthly and yearly plans alike, counted
//      from the subscription's billing anchor. A yearly plan's extra seats are
//      counted and charged month by month, so a seasonal helper costs only
//      the months they used the app. On a monthly plan a seat period is the
//      billing period.
//   2. Each period is charged ONCE, AFTER IT CLOSES, as its own invoice line
//      dated for the period it covers ("Extra active employees, Sep 9 – Oct
//      8"). On a monthly plan the line goes on the renewal invoice Stripe
//      drafts at the end of that period (the `invoice.created` webhook); a
//      yearly plan's month, or one the webhook missed, goes on an invoice of
//      its own. Not the licensed subscription item: Stripe dates that line to
//      the period it OPENS, and bills it in advance.
//   3. THE FINAL PERIOD of a cancelled subscription is charged once, when the
//      subscription ends, from its start to the moment it ended.
//   4. THE CHANGEOVER: a subscription billed under the old headcount rule has
//      paid its current period's seats in advance. That period stays paid, no
//      credit; the new rule starts with the next period. The subscription is
//      marked in its Stripe metadata (`seat_arrears_from` = the end of the
//      prepaid period) and its licensed seat item is deleted with no
//      proration, so the next renewal does not charge seats in advance.
//
// Every period is claimed in the seat_charges ledger before Stripe is called,
// keyed on (subscription, period start), so it is charged exactly once.

/** Stripe metadata keys carrying the changeover marker. */
export const SEAT_BILLING_KEY = "seat_billing";
export const SEAT_BILLING_ARREARS = "arrears";
export const SEAT_ARREARS_FROM_KEY = "seat_arrears_from";

/** Epoch seconds, as Stripe reports them. */
export type SubscriptionPeriod = { start: number; end: number };
/** A one-month seat period, epoch seconds, end exclusive. */
export type SeatPeriod = { start: number; end: number };

type MaybeSubscription = {
  current_period_start?: number | null;
  current_period_end?: number | null;
  items?: {
    data?: Array<{ current_period_start?: number | null; current_period_end?: number | null }>;
  };
};

/**
 * The billing period a subscription is in. On API versions since 2025 the
 * period lives on each item rather than the subscription; every item on one
 * subscription shares a cycle, so the item with the latest end is the one
 * to read. Null when Stripe did not say: inventing one would bill the wrong
 * people.
 */
export function subscriptionPeriod(sub: unknown): SubscriptionPeriod | null {
  const s = (sub ?? {}) as MaybeSubscription;
  if (isPositive(s.current_period_start) && isPositive(s.current_period_end)) {
    return s.current_period_end > s.current_period_start
      ? { start: s.current_period_start, end: s.current_period_end }
      : null;
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

// ── The changeover marker ─────────────────────────────────────────────────

/**
 * From which moment (epoch seconds) this subscription's seats are charged by
 * period, or null when it carries no marker (billed under the old rule).
 */
export function arrearsFrom(metadata: Record<string, string> | null | undefined): number | null {
  if (!metadata || metadata[SEAT_BILLING_KEY] !== SEAT_BILLING_ARREARS) return null;
  const from = Number(metadata[SEAT_ARREARS_FROM_KEY]);
  return Number.isFinite(from) && from >= 0 ? from : null;
}

/** The marker for a subscription billed under the old rule: its current
 *  period was prepaid, so per-period charging starts when that period ends. */
export function changeoverMarker(prepaidThrough: number): Record<string, string> {
  return {
    [SEAT_BILLING_KEY]: SEAT_BILLING_ARREARS,
    [SEAT_ARREARS_FROM_KEY]: String(Math.floor(prepaidThrough)),
  };
}

/** The marker a brand-new subscription is created with: every period, from
 *  the first, is charged after it closes. */
export function newSubscriptionSeatMarker(): Record<string, string> {
  return { [SEAT_BILLING_KEY]: SEAT_BILLING_ARREARS, [SEAT_ARREARS_FROM_KEY]: "0" };
}

// ── Seat periods ──────────────────────────────────────────────────────────

/**
 * `months` months after `anchor`, in UTC, keeping the anchor's day of the
 * month where that month has it and the last day where it does not (Jan 31 →
 * Feb 28 → Mar 31), which is how Stripe steps a monthly billing cycle.
 */
export function addMonthsUtc(anchor: number, months: number): number {
  const d = new Date(anchor * 1000);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return (
    Date.UTC(
      year,
      month,
      Math.min(d.getUTCDate(), daysInMonth),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ) / 1000
  );
}

/** Which month from the anchor contains moment `t` (0 is the anchor's own). */
export function seatMonthIndex(anchor: number, t: number): number {
  const a = new Date(anchor * 1000);
  const b = new Date(t * 1000);
  let k = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  while (addMonthsUtc(anchor, k) > t) k--;
  while (addMonthsUtc(anchor, k + 1) <= t) k++;
  return k;
}

/** The seat period (month k from the anchor) that contains moment `t`. */
export function seatPeriodAt(anchor: number, t: number): SeatPeriod {
  const k = seatMonthIndex(anchor, t);
  return { start: addMonthsUtc(anchor, k), end: addMonthsUtc(anchor, k + 1) };
}

/**
 * The seat periods that are due a charge: every month from the anchor that
 * starts at or after `from` and has closed by `until`. With `endedAt` (a
 * cancellation), the month the subscription ended in is due too, cut short
 * at the moment it ended.
 */
export function closedSeatPeriods(args: {
  anchor: number;
  from: number;
  until: number;
  endedAt?: number | null;
}): SeatPeriod[] {
  const { anchor, from } = args;
  const ended = args.endedAt ?? null;
  const until = ended != null ? Math.min(args.until, ended) : args.until;
  if (!(until > from)) return [];
  // The first month that starts at or after `from`: one that began earlier was
  // prepaid, or began before the subscription did.
  let k = seatMonthIndex(anchor, from);
  if (addMonthsUtc(anchor, k) < from) k++;
  const out: SeatPeriod[] = [];
  for (let guard = 0; guard < 400; guard++, k++) {
    const start = addMonthsUtc(anchor, k);
    if (start >= until) break;
    const end = addMonthsUtc(anchor, k + 1);
    if (end <= until) out.push({ start, end });
    else if (ended != null && until === ended) out.push({ start, end: ended });
  }
  return out;
}

// ── The invoice line ──────────────────────────────────────────────────────

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function localDate(epoch: number, timeZone: string): { y: number; m: number; d: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(new Date(epoch * 1000));
  } catch {
    return localDate(epoch, "UTC");
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month") - 1, d: get("day") };
}

/**
 * "Sep 1–30", "Sep 9 – Oct 8", "Dec 9, 2026 – Jan 8, 2027": the dates a seat
 * period covers, in the business's own time zone, last day inclusive.
 */
export function seatPeriodLabel(period: SeatPeriod, timeZone = "UTC"): string {
  const a = localDate(period.start, timeZone);
  // The period ends at the start of the next; its last day is the second before.
  const b = localDate(period.end - 1, timeZone);
  if (a.y !== b.y) return `${MONTH[a.m]} ${a.d}, ${a.y} – ${MONTH[b.m]} ${b.d}, ${b.y}`;
  if (a.m !== b.m) return `${MONTH[a.m]} ${a.d} – ${MONTH[b.m]} ${b.d}`;
  if (a.d !== b.d) return `${MONTH[a.m]} ${a.d}–${b.d}`;
  return `${MONTH[a.m]} ${a.d}`;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** What one seat period puts on an invoice. */
export function seatChargeLine(args: {
  period: SeatPeriod;
  seats: number;
  unitAmountCents: number;
  timeZone?: string;
}): { description: string; amountCents: number } {
  const seats = Math.max(0, Math.floor(args.seats));
  const unit = Math.max(0, Math.round(args.unitAmountCents));
  return {
    description: `Extra active employees, ${seatPeriodLabel(args.period, args.timeZone)} (${seats} × ${usd(unit)})`,
    amountCents: seats * unit,
  };
}

/** Epoch seconds to the ISO string Postgres is handed. */
export function periodBoundaryIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/** The explanation shown wherever the app talks about seats. One sentence,
 *  one place, so billing settings and the plan picker cannot drift apart. */
export const ACTIVE_EMPLOYEE_DEFINITION =
  "An active employee is anyone who used their login this billing period.";
