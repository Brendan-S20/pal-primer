// An extra cleanup a customer asks for from the portal, as rules the portal
// and the office both use.
//
// The database decides (portal_request_one_off refuses anything outside
// these rules); this decides what to OFFER. If they disagree the portal lists
// a day the server refuses, so the rule here is the SQL rule restated, and
// tests/a-customer-can-ask-for-an-extra-cleanup.test.ts pins both:
//
//   bookable(day)  <=>  org_today < day <= org_today + 30
//                       AND dow(day) IN work_days       (0 = Sunday)
//                       AND day is not a blackout date
//
// "Today" is the ORGANIZATION's, from org-day.ts: after dinner in Chicago the
// server is already on tomorrow, and a customer offered "tomorrow" then would
// be offered the day after.

import { addDaysToDay } from "@/lib/reclean";
import { BOOKABLE_SERVICE_LINES } from "@/lib/service-lines";
import { isZonePriced, servicePriceCents, type Service } from "@/lib/services";
import { servicePickerOptions } from "@/lib/visit-service";

export const ONE_OFF_MAX_DAYS_AHEAD = 30;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** 0 = Sunday, like Postgres extract(dow) and organizations.work_days. Pure
 *  date arithmetic in UTC, so no device zone can move it. */
export function dayOfWeek(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** Every day a customer may ask for, in order: the org's tomorrow through
 *  today + 30, on a working day, not blacked out. */
export function bookableDays(
  orgToday: string,
  workDays: number[] | null | undefined,
  blackouts: Iterable<string> = [],
): string[] {
  const work = new Set(workDays && workDays.length ? workDays : ALL_DAYS);
  const closed = new Set(blackouts);
  const out: string[] = [];
  for (let i = 1; i <= ONE_OFF_MAX_DAYS_AHEAD; i++) {
    const d = addDaysToDay(orgToday, i);
    if (!d) break;
    if (work.has(dayOfWeek(d)) && !closed.has(d)) out.push(d);
  }
  return out;
}

/** What the portal says when the server refuses, keyed by the RPC's own
 *  exception text. The codes are for logs, not for a customer. */
export function oneOffRefusalMessage(raw: string): string {
  if (/date_in_past/.test(raw)) return "That day has already passed. Please pick another.";
  if (/date_too_soon/.test(raw)) return "The earliest day you can ask for is tomorrow.";
  if (/date_too_far/.test(raw))
    return `You can ask for a day up to ${ONE_OFF_MAX_DAYS_AHEAD} days ahead.`;
  if (/not_a_working_day/.test(raw)) return "We don't work that day. Please pick another.";
  if (/blackout_day/.test(raw)) return "We're closed that day. Please pick another.";
  if (/already_scheduled/.test(raw))
    return "You already have a visit that day, so there's nothing extra to book.";
  if (/property_not_found/.test(raw)) return "We couldn't find that address on your account.";
  if (/service_not_offered/.test(raw)) return "That service isn't offered right now. Please pick another.";
  if (/invalid_token/.test(raw)) return "This portal link is no longer valid.";
  return raw;
}

/** One thing a customer can ask for from the portal (phase 5). */
export type OneOffServiceOption = Pick<
  Service,
  "price_unit" | "base_price_cents" | "extra_pet_cents" | "default_duration_min"
> & {
  id: string;
  name: string;
  /** What one visit costs for one pet, or null when the business has not set
   *  a price (the request then waits for the office, as it always has). For
   *  the price at THIS address's pet count use oneOffPriceFor. */
  priceCents: number | null;
  /** Per pet beyond the first, so the card can say "+ $5 per extra pet". */
  perExtraPetCents: number;
  /** True for the business's pet-waste service: the extra cleanup, at the
   *  one-off price, booked exactly as before the catalog. */
  petWaste: boolean;
  /** The service's line. A dog walk offers a time window (#410). Optional
   *  so an older payload without it reads as no window. */
  serviceLine?: string | null;
};

/**
 * What one visit of this option costs for `pets` pets: the one-off price for
 * the extra cleanup (pet waste has no per-pet one-off rate), the service's
 * price through the one rule for anything else. This is the number the card
 * shows before the tap and the number bookOneOffVisit charges
 * (servicePriceCents with the property's active dog count), so the two
 * cannot differ; tests/a-walk-is-priced-as-a-walk.test.ts holds them equal.
 */
export function oneOffPriceFor(option: OneOffServiceOption, pets: number): number | null {
  if (option.petWaste) return option.priceCents;
  return servicePriceCents(option, { pets });
}

/**
 * The services the portal offers to book, from the business's ACTIVE ones,
 * in the plan picker's order (pet waste first, then by line and name).
 *
 *   pet waste    the extra cleanup, at organizations.one_off_price_cents --
 *                the one thing the portal has always offered, priced as it
 *                always was (zone pricing has no per-visit answer for a
 *                one-off, which is why that setting exists).
 *   anything else   its own price for one pet, through the one rule
 *                   (servicePriceCents). A service with no price yet is not
 *                   offered: the owner has not said what it costs, and a
 *                   request with no price could only wait.
 *
 * Deactivated services are never offered, and neither is a service on a
 * line that is still Coming soon (not in BOOKABLE_SERVICE_LINES, #506): an
 * owner may price a walk ahead of launch, and a client must not be able to
 * ask for it until the line goes live. portalRequestOneOff refuses the same
 * services, so a request built by hand cannot get past this either.
 * `bookable` is the launch list; a test that drives a line's path before its
 * approval passes its own.
 */
export function oneOffServiceOptions(
  services: readonly Pick<
    Service,
    | "id"
    | "name"
    | "service_line"
    | "active"
    | "price_unit"
    | "base_price_cents"
    | "extra_pet_cents"
    | "default_duration_min"
  >[],
  oneOffPriceCents: number | null,
  bookable: readonly string[] = BOOKABLE_SERVICE_LINES,
): OneOffServiceOption[] {
  const out: OneOffServiceOption[] = [];
  for (const s of servicePickerOptions(services)) {
    if (!s.active) continue;
    if (!bookable.includes(s.service_line)) continue;
    const fields = {
      price_unit: s.price_unit,
      base_price_cents: s.base_price_cents,
      extra_pet_cents: s.extra_pet_cents,
      default_duration_min: s.default_duration_min,
    };
    if (isZonePriced(s)) {
      out.push({
        ...fields,
        id: s.id,
        name: s.name,
        priceCents: oneOffPriceCents,
        perExtraPetCents: 0,
        petWaste: true,
        serviceLine: s.service_line,
      });
      continue;
    }
    const cents = servicePriceCents(s, { pets: 1 });
    if (cents == null) continue;
    out.push({
      ...fields,
      id: s.id,
      name: s.name,
      priceCents: cents,
      perExtraPetCents: s.extra_pet_cents,
      petWaste: false,
      serviceLine: s.service_line,
    });
  }
  return out;
}

/** The note on the client's activity timeline, so the office can see why a
 *  one-off exists. Names the service when the client asked for one that is
 *  not the business's pet-waste service. */
export function oneOffVisitNote(dayLabel: string, auto: boolean, serviceName?: string | null): string {
  const what = serviceName ? `${serviceName} the client asked for` : "Extra visit the client asked for";
  return auto
    ? `${what} from the portal (booked automatically)`
    : `${what} from the portal${dayLabel ? ` for ${dayLabel}` : ""}`;
}

/** "Extra cleanup" for the pet-waste service (or no service, as every request
 *  before the catalog), else the service's own name: the word the office's
 *  inbox, email and notification use for a one-off request. */
export function oneOffRequestWord(
  service: { name: string; service_line?: string | null } | null | undefined,
): string {
  if (!service || service.service_line === "pet_waste") return "Extra cleanup";
  return service.name;
}

/** What the portal's request list says about one of these. */
export function oneOffRequestState(r: {
  status: string;
  booked_on?: string | null;
}): "booked" | "declined" | "waiting" {
  if (r.booked_on) return "booked";
  if (r.status === "resolved") return "declined";
  return "waiting";
}
