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

import {
  BOOKABLE_SERVICE_LINES,
  OFFERED_SERVICE_LINES,
  SERVICE_LINES,
  SERVICE_LINE_LABEL,
  type ServiceLine,
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
  ],
  mobile_grooming: [
    {
      name: "Bath and brush (60 min)",
      service_line: "mobile_grooming",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: 60,
      active: true,
    },
    {
      name: "Full groom (90 min)",
      service_line: "mobile_grooming",
      price_unit: "visit",
      base_price_cents: null,
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
      name: "Training package (4 sessions)",
      service_line: "training",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: 60,
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

/** The lines a service can be put on: bookable lines, anything the business
 *  already runs, and the line a service being edited already has, in the
 *  order the settings screen lists them. Lines marked Coming soon stay
 *  available for existing data. */
export function serviceLineChoices(
  orgLines: readonly ServiceLine[],
  current?: ServiceLine | null,
): ServiceLine[] {
  return SERVICE_LINES.filter(
    (l) => BOOKABLE_SERVICE_LINES.includes(l) || orgLines.includes(l) || l === current,
  );
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
    if (durationRequired(d.service_line)) return "Say how long the service usually takes.";
  } else if (!Number.isInteger(min) || min < SERVICE_DURATION_MIN || min > SERVICE_DURATION_MAX) {
    return `A duration is between ${SERVICE_DURATION_MIN} and ${SERVICE_DURATION_MAX} minutes.`;
  }
  return null;
}

/** A service priced by the business's ZONES rather than by its own row: pet
 *  waste, exactly as today. Every other line prices through
 *  servicePriceCents; this one never reaches it (phase 5, migration
 *  20261011100000). */
export function isZonePriced(s: Pick<ServiceDraft, "service_line">): boolean {
  return s.service_line === "pet_waste";
}

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
  if (s.base_price_cents === null) {
    return s.service_line === "pet_waste" ? "Priced by your zones" : "No price yet";
  }
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
