/** The service catalog: what a business sells (public.services, migration
 *  20261009200000_a-walk-is-not-a-cleanup).
 *
 *  Pure data and pure functions, shared by Settings → Services, the server
 *  functions in services.functions.ts and the tests, so the rules a form
 *  shows and the rules the server enforces are one copy:
 *
 *    how a service may be priced       PRICE_UNITS / priceUnitsFor
 *    what makes a service saveable     serviceProblem
 *    what one costs                    servicePriceCents
 *    how its price reads               servicePriceLabel
 *
 *  Pricing is "both, business chooses": every line can be flat per visit or
 *  hourly, and pet sitting can also be nightly. The database holds the same
 *  rules as CHECK constraints (services_price_unit_check,
 *  services_night_is_for_sitting); these are the sentences.
 */

import type { PublicBookingMode } from "@/lib/public-booking-mode";
import {
  isBookableLine,
  OFFERED_SERVICE_LINES,
  SERVICE_LINES,
  SERVICE_LINE_LABEL,
  type ServiceLine,
  type ServiceLineAvailability,
} from "@/lib/service-lines";

export const PRICE_UNITS = ["visit", "hour", "night"] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export const PRICE_UNIT_LABEL: Record<PriceUnit, string> = {
  visit: "Flat per visit",
  hour: "Per hour",
  night: "Per night",
};

/** The word after "$25.00 per". */
const PER: Record<PriceUnit, string> = { visit: "visit", hour: "hour", night: "night" };

/** The same bounds as the table's CHECK constraints. */
export const SERVICE_NAME_MAX = 80;
export const SERVICE_MAX_CENTS = 10_000_000;
export const SERVICE_DURATION_MIN = 1;
export const SERVICE_DURATION_MAX = 720;

/** What the seed names every existing business's pet-waste service. */
export const PET_WASTE_SERVICE_NAME = "Pet waste removal";

export type Service = {
  id: string;
  organization_id: string;
  name: string;
  service_line: ServiceLine;
  price_unit: PriceUnit;
  base_price_cents: number | null;
  extra_pet_cents: number;
  default_duration_min: number | null;
  max_dogs?: number | null;
  holiday_surcharge_pct?: number;
  /** How the public booking link starts it (#574). NULL is request only. */
  public_booking_mode?: PublicBookingMode | null;
  /** For a package: the service_packages row the link sells. */
  public_package_id?: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

/** What the form sends and the server validates: a service without its
 *  identity or timestamps. */
export type ServiceDraft = {
  name: string;
  service_line: ServiceLine;
  price_unit: PriceUnit;
  base_price_cents: number | null;
  extra_pet_cents: number;
  default_duration_min: number | null;
  max_dogs?: number | null;
  holiday_surcharge_pct?: number;
  /** Omitted on an insert: the database's default for the line (#574). */
  public_booking_mode?: PublicBookingMode | null;
  public_package_id?: string | null;
};

export type DefaultServiceSeed = ServiceDraft & { active: boolean };

/** Services each selected line gets when a business turns that line on.
 *  Prices stay blank by design. */
export const DEFAULT_SERVICE_SEEDS: Readonly<Record<ServiceLine, readonly DefaultServiceSeed[]>> = {
  pet_waste: [
    {
      name: PET_WASTE_SERVICE_NAME,
      service_line: "pet_waste",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: null,
      active: true,
    },
  ],
  dog_walking: [
    {
      name: "30-minute walk",
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: 30,
      active: true,
    },
    {
      name: "60-minute walk",
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: 60,
      active: true,
    },
    {
      name: "Drop-in visit (20 min)",
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: 20,
      active: true,
    },
  ],
  pet_sitting: [
    {
      name: "Drop-in (30 min)",
      service_line: "pet_sitting",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: 30,
      active: true,
    },
    {
      name: "Overnight stay",
      service_line: "pet_sitting",
      price_unit: "night",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: null,
      active: true,
    },
    {
      name: "House sit",
      service_line: "pet_sitting",
      price_unit: "night",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: null,
      active: true,
    },
  ],
  mobile_grooming: [
    {
      name: "Bath and tidy (60 min)",
      service_line: "mobile_grooming",
      price_unit: "visit",
      base_price_cents: 5000,
      extra_pet_cents: 0,
      default_duration_min: 60,
      active: true,
    },
    {
      name: "Full groom (90 min)",
      service_line: "mobile_grooming",
      price_unit: "visit",
      base_price_cents: 8000,
      extra_pet_cents: 0,
      default_duration_min: 90,
      active: true,
    },
    {
      name: "Nail trim (15 min)",
      service_line: "mobile_grooming",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: 15,
      active: true,
    },
  ],
  training: [
    {
      name: "Private lesson (60 min)",
      service_line: "training",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: 60,
      active: true,
    },
    {
      name: "Evaluation (45 min)",
      service_line: "training",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: 45,
      active: true,
    },
  ],
  other: [],
};

export function defaultServiceSeedsFor(lines: readonly ServiceLine[]): DefaultServiceSeed[] {
  return lines.flatMap((line) => [...DEFAULT_SERVICE_SEEDS[line]]);
}

export function isPriceUnit(v: unknown): v is PriceUnit {
  return typeof v === "string" && (PRICE_UNITS as readonly string[]).includes(v);
}

/** How a service on this line may be priced. Night is for sitting only: an
 *  overnight stay is the one service whose natural unit is a night. */
export function priceUnitsFor(line: ServiceLine): readonly PriceUnit[] {
  return line === "pet_sitting" ? PRICE_UNITS : (["visit", "hour"] as const);
}

/** Whether a duration is required. A cleanup takes as long as the YARD takes
 *  (properties.service_duration_min), so pet waste may leave it blank; a walk
 *  or a groom takes as long as the service. */
export function durationRequired(line: ServiceLine): boolean {
  return line !== "pet_waste";
}

/** The lines a service can be put on: every bookable line, plus any line the
 *  business already runs (`other` too) and the line a service being edited
 *  already has, in the order the settings screen lists them. A line that is
 *  Coming soon is offered only to a business that already runs it.
 *  `availability` is the platform switch (#531); null until it has arrived,
 *  which offers only the business's own lines. */
export function serviceLineChoices(
  orgLines: readonly ServiceLine[],
  availability: ServiceLineAvailability | null,
  current?: ServiceLine | null,
): ServiceLine[] {
  return SERVICE_LINES.filter(
    (l) =>
      (availability !== null && isBookableLine(l, availability)) ||
      orgLines.includes(l) ||
      l === current,
  );
}

/** Whether clients can book a service on this line yet, on the platform
 *  switch (#531). The rest show as Coming soon in Settings → Services, where
 *  an owner may still set them up. */
export function isBookableServiceLine(
  line: ServiceLine,
  availability: ServiceLineAvailability,
): boolean {
  return isBookableLine(line, availability);
}

const SERVICE_NAME_EXAMPLE: Record<ServiceLine, string> = {
  pet_waste: "Weekly yard cleanup",
  dog_walking: "30-minute walk",
  pet_sitting: "Overnight stay",
  mobile_grooming: "Full groom",
  training: "One-hour training session",
  other: "Standard visit",
};

/** The Name field's placeholder on the Add service form, for the kind chosen. */
export function serviceNamePlaceholder(line: ServiceLine): string {
  return SERVICE_NAME_EXAMPLE[line] ?? SERVICE_NAME_EXAMPLE.other;
}

/** "a 30-minute walk", "an overnight stay", "a one-hour training session":
 *  the example with its article, lower-cased, for a sentence (#560). "One"
 *  is said "won", so it takes "a". */
export function withArticle(noun: string): string {
  const lower = noun.toLowerCase();
  return `${/^[aeiou]/.test(lower) && !/^one\b/.test(lower) ? "an" : "a"} ${lower}`;
}

/** The line a new service starts on: the first one the business runs. */
export function defaultServiceLine(orgLines: readonly ServiceLine[]): ServiceLine {
  return orgLines[0] ?? "pet_waste";
}

/**
 * "25", "25.5", "$1,250.00" → cents. Empty → null (no price yet). Anything
 * that is not a non-negative amount with at most two decimals → NaN, so the
 * caller can say so rather than silently storing $0 (the add-ons form once
 * turned "10.00" into $1.00 by reformatting on every keystroke).
 */
export function parseDollarsToCents(input: string): number | null {
  const s = input.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (s === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(s) && !/^\.\d{1,2}$/.test(s)) return Number.NaN;
  const [whole, frac = ""] = s.split(".");
  return Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
}

/** Cents back to the string the form shows: 2550 → "25.50", null → "". */
export function centsToDollarInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

export function formatServiceMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/**
 * Why this service cannot be saved, as one sentence, or null when it can.
 * The server runs this after the schema; the form runs it before sending.
 */
export function serviceProblem(d: ServiceDraft): string | null {
  const name = d.name.trim();
  if (name.length === 0) return "Give the service a name.";
  if (name.length > SERVICE_NAME_MAX)
    return `Keep the name to ${SERVICE_NAME_MAX} characters or fewer.`;
  if (!(SERVICE_LINES as readonly string[]).includes(d.service_line))
    return "Choose what kind of service this is.";
  if (!isPriceUnit(d.price_unit)) return "Choose how this service is priced.";
  if (!priceUnitsFor(d.service_line).includes(d.price_unit))
    return "Only pet sitting can be priced per night.";
  if (
    d.max_dogs != null &&
    (d.service_line !== "dog_walking" ||
      !Number.isInteger(d.max_dogs) ||
      d.max_dogs < 1 ||
      d.max_dogs > 50)
  )
    return "A group walk needs a dog walking service with room for 1 to 50 dogs.";
  if (
    d.holiday_surcharge_pct != null &&
    (!Number.isInteger(d.holiday_surcharge_pct) ||
      d.holiday_surcharge_pct < 0 ||
      d.holiday_surcharge_pct > 500 ||
      (d.service_line !== "pet_sitting" && d.holiday_surcharge_pct !== 0))
  )
    return "A sitting holiday surcharge is a whole percentage from 0 to 500.";
  for (const [cents, what] of [
    [d.base_price_cents, "The price"],
    [d.extra_pet_cents, "The extra-pet charge"],
  ] as const) {
    if (cents === null) continue;
    if (!Number.isInteger(cents) || cents < 0) return `${what} has to be zero or more.`;
    if (cents > SERVICE_MAX_CENTS)
      return `${what} is more than ${formatServiceMoney(SERVICE_MAX_CENTS)}.`;
  }
  const min = d.default_duration_min;
  if (min === null) {
    // A night is the length. An overnight or a house sit has no minute count.
    if (d.price_unit !== "night" && durationRequired(d.service_line))
      return "Say how long the service usually takes.";
  } else if (!Number.isInteger(min) || min < SERVICE_DURATION_MIN || min > SERVICE_DURATION_MAX) {
    return `A duration is between ${SERVICE_DURATION_MIN} and ${SERVICE_DURATION_MAX} minutes.`;
  }
  return null;
}

/** A service priced by the business's ZONES rather than by its own row: pet
 *  waste, exactly as today. Every other line prices through
 *  servicePriceCents; this one never reaches it (phase 5, migration
 *  20261011100000). */
/** Pet waste is priced by its standard price, which a zone may override
 *  (standard-price.ts, #860), rather than by servicePriceCents alone. The
 *  name predates #860, when a zone was the only price a plan could have. */
export function isZonePriced(s: Pick<ServiceDraft, "service_line">): boolean {
  return s.service_line === "pet_waste";
}

/**
 * Where a one-off pet-waste visit's price is set (#641). A pet-waste service
 * is priced by zone for plans, and a one-off reads
 * organizations.one_off_price_cents. Since #788 that one number is edited
 * from two screens, the Client portal card (PortalBookingCard) and the
 * pet-waste service form on Settings -> Services, both through
 * setPortalBookingSettings, so there is still exactly one price. The
 * dispatcher's One-off dialog and the server's refusals name the portal
 * field, so they say it with the same words and link to the same field.
 */
export const ONE_OFF_PRICE_SETTING = "Settings → Client portal → Price of an extra visit";
export const ONE_OFF_PRICE_SETTING_PATH = "/settings/client-portal" as const;
/** The price input's id on that page; the link scrolls to it. */
export const ONE_OFF_PRICE_SETTING_HASH = "one-off-price";

/**
 * What one visit of this service costs, in cents, or null when the service
 * has no price of its own (pet waste priced by zone, or not set yet).
 *
 *   (base + extra pet charge × pets beyond the first) × units × multiplier
 *
 * where units is 1 for a flat visit, hours for hourly (from `minutes`, or the
 * service's own duration), and nights for nightly; and the multiplier is the
 * line's frequency multiplier, which is 1.0 for every line this function
 * prices (only pet waste multiplies by cadence, and pet waste is priced by
 * zone). Rounded once, at the end, to the nearest cent, so a 45-minute walk
 * at $20/hour is $15.00 and not the sum of two rounded halves.
 *
 * The same rule as `public.service_price_cents` (migration 20261011100000),
 * which public_quote uses; tests/a-walk-is-priced-as-a-walk.test.ts holds the
 * two to one table. The arithmetic is kept in integers until the one division
 * (cents × minutes × multiplier, then ÷ 60) so a half-cent lands on exactly
 * .5 on both sides and rounds the same way: Math.round and Postgres's
 * round(numeric) both take a positive half UP.
 */
export function servicePriceCents(
  s: Pick<
    ServiceDraft,
    "price_unit" | "base_price_cents" | "extra_pet_cents" | "default_duration_min"
  >,
  opts: { pets?: number; minutes?: number | null; nights?: number; multiplier?: number } = {},
): number | null {
  if (s.base_price_cents === null) return null;
  // A nonsense pet count (0, negative, NaN, a string that did not parse)
  // reads as one pet, never as a discount and never as NaN -- the same
  // GREATEST(COALESCE(_pets, 1), 1) the SQL applies.
  const petsRaw = Number(opts.pets ?? 1);
  const pets = Number.isFinite(petsRaw) && petsRaw >= 1 ? Math.floor(petsRaw) : 1;
  const perUnit = s.base_price_cents + s.extra_pet_cents * (pets - 1);
  const mult = opts.multiplier ?? 1;
  if (!(mult > 0)) return null;
  if (s.price_unit === "hour") {
    const minutes = opts.minutes ?? s.default_duration_min;
    if (minutes === null || minutes === undefined || !(minutes > 0)) return null;
    return Math.round((perUnit * minutes * mult) / 60);
  }
  if (s.price_unit === "night") {
    const nights = Math.max(1, Math.floor(opts.nights ?? 1));
    return Math.round(perUnit * nights * mult);
  }
  return Math.round(perUnit * mult);
}

/** How the price reads in a list: "$25.00 per visit", "$22.00 per hour,
 *  +$5.00 per extra pet", "Priced by your zones", "No price yet". */
export function servicePriceLabel(
  s: Pick<ServiceDraft, "service_line" | "price_unit" | "base_price_cents" | "extra_pet_cents">,
): string {
  // Pet waste is priced by zone for a plan and by the Client portal's extra
  // visit price for a one-off, whatever base price an older form saved (#641).
  if (s.service_line === "pet_waste") return "Priced by your zones";
  if (s.base_price_cents === null) return "No price yet";
  const per = PER[s.price_unit];
  const base = `${formatServiceMoney(s.base_price_cents)} per ${per}`;
  return s.extra_pet_cents > 0
    ? `${base}, +${formatServiceMoney(s.extra_pet_cents)} per extra pet`
    : base;
}

/** "30 min", "1 hr", "1 hr 30 min"; null when the yard decides. */
export function serviceDurationLabel(minutes: number | null): string | null {
  if (minutes === null) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

export function serviceLineLabel(line: ServiceLine): string {
  return SERVICE_LINE_LABEL[line];
}

/** Active first, then by line in the screen's order, then by name. */
export function sortServices<T extends Pick<Service, "active" | "service_line" | "name">>(
  rows: readonly T[],
): T[] {
  const lineIndex = (l: ServiceLine) => SERVICE_LINES.indexOf(l);
  return [...rows].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      lineIndex(a.service_line) - lineIndex(b.service_line) ||
      a.name.localeCompare(b.name),
  );
}

/* ------------------------------------------------------------------------
 * Pet waste on Settings -> Services (#788).
 *
 * A pet-waste service has no price of its own (isZonePriced): a repeating
 * plan is priced by its zone, and a one-time cleanup by the owner's
 * extra-visit price (organizations.one_off_price_cents, one-time-cleanup.ts).
 * The Services screen used to say so and show no number at all, which a new
 * owner read as "there is nowhere to put my $75". These helpers let the
 * screen show both real amounts and edit the one-time price in place,
 * reading the SAME two settings the booking link, the portal and quotes
 * price from, so Services, zones and the portal never hold three prices.
 * --------------------------------------------------------------------- */

/** The bounds of organizations_one_off_price_cents_check, the same ones
 *  setPortalBookingSettings validates. */
export const ONE_TIME_CLEANUP_MAX_CENTS = 1_000_000;

/** The label on the Services form's one-time price field. */
export const ONE_TIME_CLEANUP_PRICE_LABEL = "One-time cleanup price ($)";

/** The zone fields lowestZoneVisitCents reads; listZones returns more. */
export type ZoneVisitPrice = {
  base_price_cents: number | null;
  pricing_mode?: string | null;
  enabled?: boolean | null;
  /** "commercial" zones price businesses, not yards; null serves both. */
  account_type?: string | null;
};

/**
 * The lowest per-visit price any switched-on, flat-priced zone charges, or
 * null when no zone has one yet. Area-priced zones (per square foot or acre)
 * have no single visit price, so they are left out rather than guessed at,
 * and so are commercial zones, whose rate is not what a homeowner pays.
 * This is the "from" figure, before any cadence multiplier or extra dog.
 */
export function lowestZoneVisitCents(
  zones: readonly ZoneVisitPrice[] | null | undefined,
): number | null {
  let low: number | null = null;
  for (const z of zones ?? []) {
    if (z.enabled === false) continue;
    if (z.account_type === "commercial") continue;
    if ((z.pricing_mode ?? "flat") !== "flat") continue;
    const c = z.base_price_cents;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 0) continue;
    if (low === null || c < low) low = c;
  }
  return low;
}

/** How many switched-on zones override the standard price (#860): a zone
 *  whose base_price_cents is set. NULL is "uses the standard price". */
export function zoneOverrideCount(zones: readonly ZoneVisitPrice[] | null | undefined): number {
  let n = 0;
  for (const z of zones ?? []) {
    if (z.enabled === false) continue;
    const c = z.base_price_cents;
    if (typeof c === "number" && Number.isInteger(c) && c >= 0) n++;
  }
  return n;
}

/** How a pet-waste service's price reads in the Services list (#860): its
 *  own standard price, and whether any zone overrides it. The one-time
 *  cleanup price is ONE setting for the business, so it is said once above
 *  the list, not repeated on every row as if it were each service's price. */
export function petWastePriceLabel(input: {
  standardCents: number | null;
  perDogCents: number | null;
  zoneOverrides: number;
}): string {
  const std =
    input.standardCents === null
      ? "Standard price: not set yet"
      : `Standard price ${formatServiceMoney(input.standardCents)} per visit` +
        (input.perDogCents ? ` + ${formatServiceMoney(input.perDogCents)} per extra dog` : "");
  if (input.zoneOverrides === 0) return std;
  return `${std} · ${input.zoneOverrides} zone${input.zoneOverrides === 1 ? "" : "s"} with ${input.zoneOverrides === 1 ? "its" : "their"} own price`;
}

/** The one-time cleanup line above the Services list, said once (#860). */
export function oneTimeCleanupListLine(oneTimeCents: number | null): string {
  return oneTimeCents === null
    ? "One-time cleanup (any pet waste service): no price yet"
    : `One-time cleanup (any pet waste service): ${formatServiceMoney(oneTimeCents)}`;
}

/**
 * The one-time price field as setPortalBookingSettings' input, or the
 * sentence that says why it is not a price, or null when nothing changed
 * (so saving a service does not rewrite a setting nobody touched).
 *
 * Auto-accept is carried as it was, and switched off only when the price is
 * cleared, exactly as the Client portal card does: a booking made with
 * nobody looking needs a price (the server refuses the pair otherwise).
 */
export function oneTimeCleanupPriceUpdate(
  input: string,
  current: { priceCents: number | null; autoAccept: boolean },
): { data: { autoAccept: boolean; priceCents: number | null } } | { problem: string } | null {
  const cents = parseDollarsToCents(input);
  if (Number.isNaN(cents))
    return { problem: "Enter the one-time cleanup price as dollars and cents, like 75.00." };
  if (cents !== null && cents > ONE_TIME_CLEANUP_MAX_CENTS)
    return {
      problem: `The one-time cleanup price is more than ${formatServiceMoney(ONE_TIME_CLEANUP_MAX_CENTS)}.`,
    };
  if (cents === current.priceCents) return null;
  return { data: { autoAccept: current.autoAccept && cents !== null, priceCents: cents } };
}

/** What the Services form knows about the one-time cleanup setting
 *  (getPortalBookingSettings). */
export type OneTimeCleanupSetting = {
  priceCents: number | null;
  autoAccept: boolean;
  /** manage_settings, which setPortalBookingSettings asks for. */
  canEdit: boolean;
};

/**
 * The one-time price a Save on the Services form also writes, for a
 * pet-waste service: setPortalBookingSettings' input, a problem sentence, or
 * null when there is nothing to write (another line, a field that was not
 * offered, a caller who may not change it, or a price that did not change).
 */
export function petWasteOneTimeSave(
  line: ServiceLine,
  typed: string | null,
  setting: OneTimeCleanupSetting | null,
): ReturnType<typeof oneTimeCleanupPriceUpdate> {
  if (line !== "pet_waste" || typed === null || !setting?.canEdit) return null;
  return oneTimeCleanupPriceUpdate(typed, setting);
}
