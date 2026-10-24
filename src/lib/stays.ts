// A sitter's booking (#411): the day rules, the visit count and the windows,
// with no I/O so the booking form and the server read the same answers.
//
//   drop-in    visits on starts_on .. ends_on, both included, once per
//              window. Mon..Fri with two windows is ten visits.
//   overnight  one visit a night on starts_on .. ends_on - 1: ends_on is the
//              checkout morning. Mon -> Sat is five nights.
//
// The database holds the same rules (public.stays, migration 20261024080100);
// tests/a-stay-is-a-sitters-booking.test.ts holds the two together.

import { arrivalWindowsProblem, type WalkWindow } from "@/lib/subscription-form";
import { formatServiceMoney, servicePriceCents, type ServiceDraft } from "@/lib/services";
import { clockLabel, normalizeClock, windowLabel } from "@/lib/walk-windows";

export type StayKind = "drop_in" | "overnight";
export type StayStatus = "requested" | "confirmed" | "canceled" | "completed";

export const MAX_DROP_IN_WINDOWS = 4;
export const DEFAULT_OVERNIGHT_ARRIVAL: WalkWindow = { earliestTime: "19:00", latestTime: "21:00" };
export const DEFAULT_DROP_IN_WINDOW: WalkWindow = { earliestTime: "08:00", latestTime: "10:00" };
/** A stay's plans run every day of the week, 0 = Sunday. */
export const EVERY_DAY: readonly number[] = [0, 1, 2, 3, 4, 5, 6];
/** Longer than any trip a sitter is booked for; keeps a typo year out. */
export const STAY_MAX_DAYS = 90;

export const STAY_KIND_LABEL: Record<StayKind, string> = {
  drop_in: "Drop-ins",
  overnight: "Overnight",
};

export const STAY_STATUS_LABEL: Record<StayStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  canceled: "Canceled",
  completed: "Completed",
};

/** A service priced per night is an overnight; anything else is a drop-in.
 *  The same CASE tg_stays_validate applies. */
export function stayKindFor(priceUnit: string | null | undefined): StayKind {
  return priceUnit === "night" ? "overnight" : "drop_in";
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * 86_400_000);
}

/** The calendar days between two YYYY-MM-DD days (end minus start). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

/** The last day a stay's plans run: ends_on for drop-ins, the night before
 *  checkout for an overnight. */
export function lastVisitDay(kind: StayKind, startsOn: string, endsOn: string): string {
  return kind === "overnight" ? addDays(endsOn, -1) : endsOn;
}

/** Every day with a visit, in order. Empty when the dates do not make a stay. */
export function stayDays(kind: StayKind, startsOn: string, endsOn: string): string[] {
  if (!DAY.test(startsOn) || !DAY.test(endsOn)) return [];
  const last = lastVisitDay(kind, startsOn, endsOn);
  const n = daysBetween(startsOn, last);
  if (n < 0) return [];
  return Array.from({ length: n + 1 }, (_, i) => addDays(startsOn, i));
}

/** How many visits a stay makes: days × windows for drop-ins, one a night for
 *  an overnight. */
export function stayVisitCount(
  kind: StayKind,
  startsOn: string,
  endsOn: string,
  windowCount: number,
): number {
  const days = stayDays(kind, startsOn, endsOn).length;
  return kind === "overnight" ? days : days * Math.max(0, windowCount);
}

/** "This creates 10 visits." */
export function visitCountSentence(n: number): string {
  return n === 1 ? "This creates 1 visit." : `This creates ${n} visits.`;
}

/** Why these dates cannot be booked, or null. */
export function stayDatesProblem(kind: StayKind, startsOn: string, endsOn: string): string | null {
  if (!DAY.test(startsOn) || !DAY.test(endsOn))
    return kind === "overnight"
      ? "Choose a check-in and check-out day."
      : "Choose a first and last day.";
  if (kind === "overnight") {
    if (endsOn <= startsOn) return "Check-out has to be at least one day after check-in.";
  } else if (endsOn < startsOn) {
    return "The last day can't be before the first day.";
  }
  if (daysBetween(startsOn, endsOn) > STAY_MAX_DAYS)
    return `A stay is up to ${STAY_MAX_DAYS} days.`;
  return null;
}

/** Drop-in windows: one to four, each a valid range, no two the same. The
 *  same rule as public.stay_windows_are_valid. */
export function stayWindowsProblem(windows: readonly WalkWindow[]): string | null {
  return arrivalWindowsProblem(windows, MAX_DROP_IN_WINDOWS, "drop-in");
}

/** The overnight arrival window: one valid range. */
export function arrivalWindowProblem(w: WalkWindow): string | null {
  return arrivalWindowsProblem([w], 1, "arrival");
}

/** The windows each of a stay's plans uses, in time order: one per drop-in
 *  window, or the overnight arrival window alone. */
export function stayPlanWindows(
  kind: StayKind,
  windows: readonly WalkWindow[],
  arrival: WalkWindow = DEFAULT_OVERNIGHT_ARRIVAL,
): WalkWindow[] {
  if (kind === "overnight") return [arrival];
  return [...windows].sort((a, b) => a.earliestTime.localeCompare(b.earliestTime));
}

/** One visit's price: the service's rule for the pets on the stay, one night
 *  per overnight visit. Null when the service has no price yet. */
export function stayVisitPriceCents(
  service: Pick<
    ServiceDraft,
    "price_unit" | "base_price_cents" | "extra_pet_cents" | "default_duration_min"
  >,
  pets: number,
): number | null {
  return servicePriceCents(service, { pets: Math.max(1, pets), nights: 1 });
}

/** The sentence the database raises (tg_visits_stay_sitter) when a sitter
 *  would have two overnights on one night, written the same way here for the
 *  check the server makes before it writes anything. */
export function overnightConflictSentence(
  sitter: string | null | undefined,
  night: string,
): string {
  const d = new Date(`${night}T12:00:00Z`);
  const when = d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${sitter?.trim() || "This sitter"} already has an overnight stay on the night of ${when}.`;
}

/** The first night in `nights` that is already taken, or null. */
export function firstTakenNight(nights: readonly string[], taken: Iterable<string>): string | null {
  const set = new Set(taken);
  return nights.find((n) => set.has(n)) ?? null;
}

/** A visit's stay, as its plan embeds it (subscriptions.stays). */
export type VisitStayRef = {
  kind?: string | null;
  starts_on?: string | null;
  ends_on?: string | null;
} | null;

/** The dates beside a stay visit's service name: "Oct 19 to Oct 23", or null
 *  when the visit is not part of a stay. */
export function visitStayDates(stay: VisitStayRef | undefined): string | null {
  if (!stay?.starts_on || !stay.ends_on) return null;
  return stayDatesLabel(
    stay.kind === "overnight" ? "overnight" : "drop_in",
    stay.starts_on,
    stay.ends_on,
  );
}

/** "Oct 19 to Oct 23", or "Check-in Oct 19, check-out Oct 24" for an overnight. */
export function stayDatesLabel(kind: StayKind, startsOn: string, endsOn: string): string {
  const fmt = (day: string) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  if (kind === "overnight") return `Check-in ${fmt(startsOn)}, check-out ${fmt(endsOn)}`;
  return startsOn === endsOn ? fmt(startsOn) : `${fmt(startsOn)} to ${fmt(endsOn)}`;
}

// ── Changing a confirmed stay ────────────────────────────────────────────
//
// change_stay (migration 20261024080400) holds the same rules: a scheduled
// visit from the business's today on is still to come, and the stay can end
// no earlier than its last visit already under way or done, nor before
// yesterday.

/** A stay visit as the change form and a cancel read it. */
export type StayVisitRef = { scheduled_on: string; status: string };

/** Which visits are worked and which are still to come. A scheduled visit
 *  from today on is to come; a canceled one is neither; every other visit is
 *  worked and stays billed. */
export function splitStayVisits<V extends StayVisitRef>(
  visits: readonly V[],
  today: string,
): { worked: V[]; future: V[] } {
  const worked: V[] = [];
  const future: V[] = [];
  for (const v of visits) {
    if (v.status === "canceled") continue;
    if (v.status === "scheduled" && v.scheduled_on >= today) future.push(v);
    else worked.push(v);
  }
  return { worked, future };
}

/** The earliest end date the office can pick: the last day a visit was under
 *  way or done, and never before yesterday. Overnights give the checkout
 *  morning, the day after that night. */
export function earliestStayEnd(
  kind: StayKind,
  visits: readonly StayVisitRef[],
  today: string,
): string {
  let last = addDays(today, -1);
  for (const v of visits)
    if ((v.status === "in_progress" || v.status === "completed") && v.scheduled_on > last)
      last = v.scheduled_on;
  return kind === "overnight" ? addDays(last, 1) : last;
}

/** One visit's price after the pets change: the current price moved by the
 *  service's own difference between the two pet counts, so a price the
 *  office typed at booking keeps its offset. Null when the service has no
 *  price. Never below zero. */
export function changedVisitPriceCents(
  currentCents: number,
  service: Parameters<typeof stayVisitPriceCents>[0],
  oldPets: number,
  newPets: number,
): number | null {
  if (oldPets === newPets) return currentCents;
  const before = stayVisitPriceCents(service, oldPets);
  const after = stayVisitPriceCents(service, newPets);
  if (before == null || after == null) return null;
  return Math.max(0, currentCents + after - before);
}

/** What a change adds to the stay's bill (positive) or takes off (negative),
 *  before tax and holiday rates. Worked visits keep their price; the visits
 *  still to come are replaced by the new days at the new price. */
export function stayChangeDifferenceCents(input: {
  kind: StayKind;
  windowCount: number;
  today: string;
  visits: readonly StayVisitRef[];
  currentVisitCents: number;
  newVisitCents: number;
  startsOn: string;
  endsOn: string;
}): number {
  const { worked, future } = splitStayVisits(input.visits, input.today);
  const perDay = input.kind === "overnight" ? 1 : Math.max(0, input.windowCount);
  const days = stayDays(input.kind, input.startsOn, input.endsOn).filter((d) => d >= input.today);
  // A visit done today already fills one of today's slots.
  const doneFromToday = worked.filter((v) => v.scheduled_on >= input.today).length;
  const toCome = Math.max(0, days.length * perDay - doneFromToday);
  return toCome * input.newVisitCents - future.length * input.currentVisitCents;
}

/** "Adds $45.00 before tax.", "Takes $30.00 off before tax." or "No change
 *  to the price." */
export function priceDifferenceSentence(cents: number, money: (c: number) => string): string {
  if (cents > 0) return `Adds ${money(cents)} before tax.`;
  if (cents < 0) return `Takes ${money(-cents)} off before tax.`;
  return "No change to the price.";
}

// ── Who sees the codes, and when ─────────────────────────────────────────
//
// stay_access_codes (migration 20261024080500) gives a stay's sitter the
// gate code, lock box code, key and alarm details from the day before the
// stay's first visit to the end of its last visit day. The sit card uses the
// same window to say when the codes will show.

export type StayAccessWindow = { from: string; through: string };

/** The window for a stay with visits on these days, or null with none. */
export function stayAccessWindow(visitDays: readonly string[]): StayAccessWindow | null {
  const days = visitDays.filter((d) => DAY.test(d)).sort();
  if (days.length === 0) return null;
  return { from: addDays(days[0], -1), through: days[days.length - 1] };
}

/** Whether `today` is inside the window. */
export function stayAccessOpen(today: string, window: StayAccessWindow | null): boolean {
  return !!window && today >= window.from && today <= window.through;
}

// ── Who to call ──────────────────────────────────────────────────────────
//
// stay_contact_gaps (migration 20261024080600) names what a stay is missing
// for an emergency. Confirming warns about it and never refuses.

export const STAY_CONTACT_GAPS = ["emergency_contact", "vet", "treatment_limit"] as const;
export type StayContactGap = (typeof STAY_CONTACT_GAPS)[number];

const GAP_LABEL: Record<StayContactGap, string> = {
  emergency_contact: "an emergency contact with a phone",
  vet: "a vet clinic and phone for every pet",
  treatment_limit: "a vet treatment limit",
};

const filled = (v: string | null | undefined) => !!v?.trim();

/** The same answer stay_contact_gaps gives, from the client and the pets on
 *  the stay, for the booking form before anything is saved. */
export function stayContactGapsFor(
  client: {
    emergency_contact_name?: string | null;
    emergency_contact_phone?: string | null;
    vet_treatment_limit_cents?: number | null;
  } | null,
  pets: ReadonlyArray<{ vet_clinic_name?: string | null; vet_clinic_phone?: string | null }>,
): StayContactGap[] {
  const gaps: StayContactGap[] = [];
  if (!filled(client?.emergency_contact_name) || !filled(client?.emergency_contact_phone))
    gaps.push("emergency_contact");
  if (pets.some((p) => !filled(p.vet_clinic_name) || !filled(p.vet_clinic_phone))) gaps.push("vet");
  if (client?.vet_treatment_limit_cents == null) gaps.push("treatment_limit");
  return gaps;
}

/** "Missing: an emergency contact with a phone. The sitter needs this if a
 *  pet is sick." for the office, or null when nothing is missing. Unknown
 *  codes are ignored. */
export function stayContactGapsSentence(gaps: readonly string[] | null | undefined): string | null {
  const known = STAY_CONTACT_GAPS.filter((g) => gaps?.includes(g)).map((g) => GAP_LABEL[g]);
  if (known.length === 0) return null;
  return `Missing: ${known.join(", ")}. The sitter needs ${
    known.length === 1 ? "this" : "these"
  } if a pet is sick.`;
}

// ── The deposit when a stay is canceled ──────────────────────────────────
//
// tg_stays_follow (migration 20261024080900) refunds the deposit when the
// stay starts at least organizations.stay_deposit_refund_days later, and
// otherwise keeps it as a cancellation fee. The office can refund anyway.

export const DEFAULT_DEPOSIT_REFUND_DAYS = 7;

/** The same test tg_stays_follow makes: starts_on - today >= days. */
export function depositRefundable(startsOn: string, today: string, days: number): boolean {
  return daysBetween(today, startsOn) >= days;
}

/** What canceling today does with the deposit, for the cancel dialog, or
 *  null when the stay has no deposit. */
export function depositCancelSentence(args: {
  depositCents: number | null | undefined;
  startsOn: string;
  today: string;
  refundDays: number;
}): string | null {
  if (!args.depositCents) return null;
  const money = formatServiceMoney(args.depositCents);
  const days = args.refundDays === 1 ? "1 day" : `${args.refundDays} days`;
  if (depositRefundable(args.startsOn, args.today, args.refundDays))
    return `The ${money} deposit is refunded. Unpaid, its invoice is voided. Paid, it stays on the client's account as credit.`;
  const left = daysBetween(args.today, args.startsOn);
  const when =
    left < 0
      ? "The stay has started"
      : left === 0
        ? "The stay starts today"
        : `The stay starts in less than ${days}`;
  return `${when}, so the ${money} deposit is kept as a cancellation fee.`;
}

// ── Holiday dates ────────────────────────────────────────────────────────
//
// holiday_dates (migration 20261024080800) price a sitting visit on the date
// at its service's holiday surcharge. An overnight's visit is dated the
// evening it starts, so the night that counts starts on the date.

/** "Thu, Dec 24, 2026" */
export function holidayDateLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "Overnights: the night of Dec 24 into Dec 25" */
export function holidayNightLabel(day: string): string {
  const md = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `Overnights: the night of ${md(day)} into ${md(addDays(day, 1))}`;
}

// ── A sitter's evening ───────────────────────────────────────────────────
//
// overnight_clashes (migration 20261024080700) finds a sitter's other visits
// inside one of their overnights: after the arrival window opens that
// evening, or before 8 AM the next morning. It warns and never refuses.

/** When an overnight sitter is free again the next morning. */
export const OVERNIGHT_ENDS = "08:00";

/** The same rule as public.overnight_covers. Clocks are "HH:MM" or
 *  "HH:MM:SS". A visit with no window never clashes. */
export function overnightCovers(
  night: string,
  arrival: string,
  on: string,
  earliest: string | null,
  latest: string | null,
): boolean {
  const a = normalizeClock(arrival);
  const e = normalizeClock(earliest);
  const l = normalizeClock(latest) ?? e;
  if (!a || !l) return false;
  if (on === night) return l > a;
  if (on === addDays(night, 1)) return !!e && e < OVERNIGHT_ENDS;
  return false;
}

export type OvernightClash = {
  sitter_name: string | null;
  night_of: string;
  arrival: string | null;
  visit_on: string;
  visit_earliest: string | null;
  visit_latest: string | null;
  client_name: string | null;
};

function shortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** One warning for the office, or null when nothing clashes. */
export function overnightClashSentence(
  clashes: readonly OvernightClash[] | null | undefined,
): string | null {
  const first = clashes?.[0];
  if (!first) return null;
  const sitter = first.sitter_name?.trim() || "This sitter";
  const arrives = clockLabel(first.arrival);
  const when = windowLabel(first.visit_earliest, first.visit_latest);
  const client = first.client_name?.trim();
  let s =
    `${sitter} has an overnight stay the night of ${shortDay(first.night_of)}` +
    (arrives ? `, arriving from ${arrives}` : "") +
    `. Their visit${client ? ` for ${client}` : ""} on ${shortDay(first.visit_on)}` +
    (when ? `, ${when},` : "") +
    " falls inside it.";
  const more = clashes!.length - 1;
  if (more > 0) s += ` ${more} more ${more === 1 ? "visit does" : "visits do"} too.`;
  return s;
}
