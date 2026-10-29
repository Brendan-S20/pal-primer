/** What a stranger may pick from: the business's services as public_services
 *  (migration 20261011150000) hands them to the public signup and quote form.
 *
 *  Pure, so the form, the server functions and the tests read one copy of:
 *
 *    which rows count                 publicServiceChoices
 *    whether there is anything to pick  offersAChoice
 *    what the picker starts on        defaultPublicServiceId
 *    what is quoted and charged       quotedPublicService
 *    whether the yard questions apply   asksAboutTheYard
 *    whether it is asked for, not sold  isRequestedAsAStay
 *    whether it has a price online    isPricedOnline
 *    why it is a request, if it is    requestedBecause
 *    how an option reads              publicServiceOptionLabel
 *
 *  The rule the whole file exists for: a business that sells ONE thing sees
 *  no picker. A pet-waste-only business (the common case) also sends no
 *  service id in any request and has none on its lead or its signup: its
 *  signup stays byte-for-byte what it was
 *  (tests/a-stranger-can-see-what-is-for-sale.test.ts holds it there). A
 *  business whose one service is a walk, a sit or a groom sends that
 *  service's id (quotedPublicService), so it is priced as itself and never
 *  as a yard (#525).
 */

import { isPriceUnit, isZonePriced, serviceDurationLabel, type PriceUnit } from "@/lib/services";
import {
  bookingLinkOffersLine,
  SERVICE_LINES,
  type ServiceLine,
  type ServiceLineAvailability,
} from "@/lib/service-lines";
import {
  effectiveBookingMode,
  isPublicBookingMode,
  parsePublicPackage,
  type PublicBookingMode,
  type PublicPackage,
} from "@/lib/public-booking-mode";

/** One row of public_services: what public_quote needs back, and what a
 *  visitor needs to choose. No organization column. */
export type PublicService = {
  id: string;
  name: string;
  service_line: ServiceLine;
  price_unit: PriceUnit;
  base_price_cents: number | null;
  extra_pet_cents: number;
  default_duration_min: number | null;
  /** How the link starts it (#574), read by getPublicSignupForm with the
   *  service role. Absent or unknown reads as a request. */
  booking_mode?: PublicBookingMode | null;
  /** The package a `package` service sells, when it has one to sell. */
  package?: PublicPackage | null;
};

function isServiceLine(v: unknown): v is ServiceLine {
  return typeof v === "string" && (SERVICE_LINES as readonly string[]).includes(v);
}

/**
 * The rows the RPC returned, typed and in its order (by line, pet waste
 * first, then by name). Anything that is not a row of the right shape is
 * dropped rather than guessed at: a malformed row would otherwise become a
 * picker option whose id public_quote refuses.
 *
 * A row on a line that is still Coming soon (not bookable on the platform
 * switch, #531) is dropped too (#506): an owner may set up a sit before
 * launch, and a stranger must not be able to pick it. public_services leaves
 * it out as well (20261018150000, 20261028120000); this is the same rule for
 * a database that has not caught up. Every live line is kept, walking,
 * training and grooming included (bookingLinkOffersLine, #560). `availability`
 * is the switch, read at runtime (loadServiceLineAvailability).
 */
export function publicServiceChoices(
  raw: unknown,
  availability: ServiceLineAvailability,
): PublicService[] {
  if (!Array.isArray(raw)) return [];
  const out: PublicService[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.name !== "string") continue;
    if (!isServiceLine(o.service_line) || !isPriceUnit(o.price_unit)) continue;
    if (!bookingLinkOffersLine(o.service_line, availability)) continue;
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    out.push({
      id: o.id,
      name: o.name,
      service_line: o.service_line,
      price_unit: o.price_unit,
      base_price_cents: typeof o.base_price_cents === "number" ? o.base_price_cents : null,
      extra_pet_cents: typeof o.extra_pet_cents === "number" ? o.extra_pet_cents : 0,
      default_duration_min:
        typeof o.default_duration_min === "number" ? o.default_duration_min : null,
      booking_mode: isPublicBookingMode(o.booking_mode) ? o.booking_mode : null,
      package: parsePublicPackage(o.package),
    });
  }
  return out;
}

/** True when there is a choice to make. One service, or none listed, is the
 *  form as it always was. */
export function offersAChoice(services: readonly PublicService[]): boolean {
  return services.length > 1;
}

/** What the picker starts on when there is a choice: the business's pet-waste
 *  service when it sells one (the thing every business sold until the
 *  catalog), else the first service listed. Null when there is no choice,
 *  so nothing is sent. */
export function defaultPublicServiceId(services: readonly PublicService[]): string | null {
  if (!offersAChoice(services)) return null;
  return services.find((s) => isZonePriced(s))?.id ?? services[0]?.id ?? null;
}

/** The service a visitor has chosen, or null when there is nothing to
 *  choose: `pickedId` first, the default when it names nothing listed. */
export function chosenPublicService(
  services: readonly PublicService[],
  pickedId: string | null | undefined,
): PublicService | null {
  if (!offersAChoice(services)) return null;
  return (
    services.find((s) => s.id === pickedId) ??
    services.find((s) => s.id === defaultPublicServiceId(services)) ??
    null
  );
}

/** The service the form quotes, charges and words itself for: the one picked
 *  when there is a choice, else the business's ONLY service when that one is
 *  not zone-priced. A business that sells one walk has no picker, but its
 *  walk is still a walk: quoted by its id, public_quote prices the service
 *  (no first cleanup, no rate card) instead of the zone's scooping price, and
 *  the yard questions are not asked. A pet-waste-only business, or one that
 *  lists nothing, still gets null and sends no id: its form is unchanged. */
export function quotedPublicService(
  services: readonly PublicService[],
  pickedId: string | null | undefined,
): PublicService | null {
  if (offersAChoice(services)) return chosenPublicService(services, pickedId);
  const only = services.length === 1 ? services[0] : null;
  return only && !isZonePriced(only) ? only : null;
}

/** Whether the pet-waste questions ("when was your yard last cleaned?", the
 *  first cleanup line) apply. They do with no choice made (the form as it
 *  was) and for the pet-waste service; a walk has no yard to ask about. */
export function asksAboutTheYard(chosen: PublicService | null): boolean {
  return chosen === null || isZonePriced(chosen);
}

/** Whether the service is a STAY: priced per night (an Overnight stay, a
 *  House sit), so it is asked for and confirmed by the office rather than
 *  sold online (#546). The public signup provisions a subscription on a
 *  cadence, and a night is not a visit that repeats weekly: a stranger who
 *  could "Start service" on one would be subscribed to a nightly stay. So a
 *  stay offers no cadence, no instant price and no card, only the quote
 *  request, which writes a lead with the pets, the access notes and the
 *  preferred first night the form already asks for. A drop-in (per visit)
 *  or an hourly sit is not a stay and keeps the signup path. */
export function isRequestedAsAStay(chosen: { price_unit?: unknown } | null | undefined): boolean {
  return chosen?.price_unit === "night";
}

/** Whether the service has a price a stranger can be quoted: the zone's rate
 *  card for pet waste, else the service's own base price. A walk the owner
 *  has listed but not priced yet is still offered (#560), as a request: the
 *  office sends the price. */
export function isPricedOnline(
  s: { service_line: ServiceLine; base_price_cents: number | null; package?: PublicPackage | null },
  hasSizePrices = false,
): boolean {
  if (effectiveBookingMode(s as PublicService) === "package") return true;
  return isZonePriced(s) || s.base_price_cents != null || hasSizePrices;
}

/** Why the chosen service is asked for rather than started online, or null
 *  when it can be started. A stay is a run of nights (#546). A groom is an
 *  appointment on one groomer's van, which the office places, so it is
 *  priced here with each pet's size and the add-ons and then requested
 *  (#560). A service with no price yet is requested so the office can send
 *  one. A service the owner set to request only, or left unset, is asked
 *  for (#574). Nothing chosen (the form as it always was) is never a
 *  request. */
export function requestedBecause(
  chosen: PublicService | null,
  hasSizePrices = false,
): "stay" | "groom" | "unpriced" | "request_only" | null {
  if (!chosen) return null;
  if (isRequestedAsAStay(chosen)) return "stay";
  // The owner's answer (#574): a service set to Request a quote only, or
  // with no answer, takes no card. Before the price, because a request
  // that is not priced reads the same either way.
  if (effectiveBookingMode(chosen) === "request_only") return "request_only";
  if (!isPricedOnline(chosen, hasSizePrices)) return "unpriced";
  if (chosen.service_line === "mobile_grooming") return "groom";
  return null;
}

/** A length already written into a service's name: "30 min", "90 mins",
 *  "1 hr", "2 hours", "45-minute". */
const SAYS_ITS_LENGTH = /\b\d+(?:\.\d+)?\s*-?\s*(?:min|mins|minutes?|hr|hrs|hours?)\b/i;

/** How an option reads in the picker: the business's own name, and how long
 *  it usually takes when the service says. Never a price: the price is the
 *  quote's to say, for this ZIP and these pets. A name that already says
 *  its length ("Drop-in (30 min)", "Full groom (90 min)") is not told it
 *  again (#560). */
export function publicServiceOptionLabel(s: PublicService): string {
  const duration = serviceDurationLabel(s.default_duration_min);
  if (!duration || isZonePriced(s) || SAYS_ITS_LENGTH.test(s.name)) return s.name;
  return `${s.name} (${duration})`;
}

/** The services the picker draws, in order: each label once (#560). Two
 *  services that read the same and cost the same ("Drop-in" and "Drop-in
 *  (30 min)", both 30 minutes at $25, as Riverbend's demo has them) are one
 *  choice to a visitor, so the first stands for both; either is quoted the
 *  same. Two that read the same at different prices are both kept. */
export function publicServiceOptions(services: readonly PublicService[]): PublicService[] {
  const seen = new Map<string, PublicService>();
  const out: PublicService[] = [];
  for (const s of services) {
    const label = publicServiceOptionLabel(s);
    const twin = seen.get(label);
    if (
      twin &&
      twin.service_line === s.service_line &&
      twin.price_unit === s.price_unit &&
      twin.base_price_cents === s.base_price_cents &&
      twin.extra_pet_cents === s.extra_pet_cents
    )
      continue;
    if (!twin) seen.set(label, s);
    out.push(s);
  }
  return out;
}

/** The listed services with how the link starts each (#574), from the
 *  service rows' public_booking_mode and the packages they sell, both read
 *  with the service role for these services only. A row the lookup did not
 *  return keeps no mode, which reads as a request. A package is attached
 *  only when it is active, priced, and this service's own. */
export function withBookingModes(
  services: readonly PublicService[],
  modeRows: unknown,
  packageRows: unknown,
): PublicService[] {
  const modes = new Map<string, { mode: unknown; packageId: unknown }>();
  for (const r of Array.isArray(modeRows) ? modeRows : []) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id === "string")
      modes.set(o.id, { mode: o.public_booking_mode, packageId: o.public_package_id });
  }
  const packages = new Map<string, Record<string, unknown>>();
  for (const r of Array.isArray(packageRows) ? packageRows : []) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id === "string") packages.set(o.id, o);
  }
  return services.map((s) => {
    const m = modes.get(s.id);
    const row = typeof m?.packageId === "string" ? packages.get(m.packageId) : undefined;
    const pkg =
      row && row.active === true && row.service_id === s.id ? parsePublicPackage(row) : null;
    return {
      ...s,
      booking_mode: isPublicBookingMode(m?.mode) ? m.mode : null,
      package: pkg,
    };
  });
}
