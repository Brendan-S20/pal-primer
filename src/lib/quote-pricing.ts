// A quote started from nothing.
//
// Owner, 2026-10-01: "we need to make the walkthrough for that more friendly;
// I feel like at this moment, there's too many forms, for example; quotes, I'm
// not sure why zone pricing or base pricing isn't already pre-inputted or have
// them available as an option."
//
// The quote editor opened on two blank lines and a price box, for a business
// that had already told the app what it charges -- per zone on the Zones page,
// and as a company-wide standard price in Settings. This file turns what the
// app knows about the person being quoted into the recurring service line the
// owner would otherwise type, and lists every price the owner has set so one
// can be picked instead of typed. Pure: the caller loads the zones, the
// standard price and the subject, and passes them in.
//
// The rules, in order:
//   1. The zone is the one that ACTUALLY applies. For a client's property that
//      is `properties.zone_id` -- the matcher's answer, or the owner's override
//      of it (properties.functions.ts: "zone_id is what actually applies").
//      With no stored zone (a lead, a property never matched), matchZone() in
//      zone-match.ts decides, from the ZIP and the point we have.
//   2. A zone with no price of the account's kind is not a price. A residential
//      zone with a $0 base, or a commercial account in a zone with no
//      commercial rates, falls through to the standard price.
//   3. No zone, or no priced zone: the standard price (Settings > Preferences),
//      when one is set. Residential only, as everywhere else it is shown.
//   4. Nothing set at all: no prefill. The line stays blank and says why.
//
// Every price is per visit, after the org's frequency multiplier, which is
// what a quote's "per visit" line means and what the new-client wizard stores.

import {
  computeCommercialZonePrice,
  computeZoneVisitPrice,
  zoneHasCommercialPricing,
  type CommercialZonePricingFields,
  type ZonePricingFields,
} from "./pricing";
import { matchZone, type ZoneMatchFields } from "./zone-match";

export interface QuotePricingZone
  extends ZoneMatchFields, Partial<ZonePricingFields>, Partial<CommercialZonePricingFields> {
  id: string;
  name: string;
}

export interface QuoteStandardPricing {
  basePriceCents: number | null;
  perDogAddlCents: number | null;
  frequencyMultipliers: Record<string, number>;
}

/** What the app knows about the person being quoted. Every field optional. */
export interface QuoteSubject {
  /** The zone stored on their property, override included. */
  zoneId?: string | null;
  postalCode?: string | null;
  point?: { lat: number; lng: number } | null;
  accountType?: "residential" | "commercial" | null;
  dogCount?: number | null;
  /** Total units, for a commercial property. */
  unitCount?: number | null;
  boundaryAreaSqm?: number | null;
  frequency?: string | null;
}

/** The frequencies a quote line can be priced at, in the wizard's spelling. */
export const QUOTE_FREQUENCIES = ["weekly", "biweekly", "twice_weekly", "monthly"] as const;
export type QuoteFrequency = (typeof QUOTE_FREQUENCIES)[number];

const VISIT_WORDS: Record<QuoteFrequency, string> = {
  weekly: "Weekly visit",
  biweekly: "Every-2-weeks visit",
  twice_weekly: "Twice-weekly visit",
  monthly: "Monthly visit",
};

export function quoteFrequency(raw: string | null | undefined): QuoteFrequency {
  return (QUOTE_FREQUENCIES as readonly string[]).includes(raw ?? "")
    ? (raw as QuoteFrequency)
    : "weekly";
}

export interface PricingChoice {
  /** "zone:<id>" or "standard". */
  id: string;
  source: "zone" | "standard";
  zoneId: string | null;
  /** "Central Austin" or "Standard pricing", for a picker. */
  label: string;
  /** The sentence shown under a prefilled line. */
  note: string;
  /** Per visit, after the frequency multiplier. */
  priceCents: number;
  /** The line it becomes. */
  description: string;
  /** How the number was reached, in words, so it can be checked. */
  breakdown: string;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** A pricing note as one sentence. One zone note already ends in a full stop
 *  (the unmeasured-yard one), and the editor adding another printed
 *  "charge.." (#433). */
export function asSentence(note: string): string {
  const s = note.trim();
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function dogsWord(n: number) {
  return `${n} ${n === 1 ? "dog" : "dogs"}`;
}

function zoneIsPricedFor(zone: QuotePricingZone, kind: "residential" | "commercial"): boolean {
  if (kind === "commercial") return zoneHasCommercialPricing(zone as CommercialZonePricingFields);
  const mode = zone.pricing_mode ?? "flat";
  return (
    (zone.base_price_cents ?? 0) > 0 ||
    (mode === "per_sqft" && Number(zone.price_per_sqft_cents ?? 0) > 0) ||
    (mode === "per_acre" && (zone.price_per_acre_cents ?? 0) > 0)
  );
}

/** One zone's price for this subject, or null when the zone has none for the
 *  account's kind. */
export function zoneChoice(
  zone: QuotePricingZone,
  subject: QuoteSubject,
  standard: QuoteStandardPricing | null,
): PricingChoice | null {
  const kind = subject.accountType === "commercial" ? "commercial" : "residential";
  if (!zoneIsPricedFor(zone, kind)) return null;
  const frequency = quoteFrequency(subject.frequency);
  const mult = Number(standard?.frequencyMultipliers?.[frequency] ?? 1) || 1;
  const multNote = mult !== 1 ? `, x${mult} for ${VISIT_WORDS[frequency].toLowerCase()}s` : "";

  if (kind === "commercial") {
    const units = Math.max(1, Math.round(subject.unitCount ?? 1));
    const r = computeCommercialZonePrice(zone as CommercialZonePricingFields, {
      unitCount: units,
      boundaryAreaSqm: subject.boundaryAreaSqm ?? null,
      multiplier: mult,
    });
    return {
      id: `zone:${zone.id}`,
      source: "zone",
      zoneId: zone.id,
      label: zone.name,
      note: `Priced from ${zone.name}`,
      priceCents: r.recurringCents,
      description: `${VISIT_WORDS[frequency]}, ${units} ${units === 1 ? "unit" : "units"}`,
      breakdown:
        `${money(r.baseCents)} base + ${money(r.unitCents)} for ${units} ${units === 1 ? "unit" : "units"}` +
        (r.acreageCents ? ` + ${money(r.acreageCents)} grounds` : "") +
        multNote,
    };
  }

  const dogs = Math.max(1, Math.min(20, Math.round(subject.dogCount ?? 1)));
  const r = computeZoneVisitPrice(
    {
      base_price_cents: zone.base_price_cents ?? 0,
      per_dog_addl_cents: zone.per_dog_addl_cents ?? 0,
      pricing_mode: zone.pricing_mode ?? "flat",
      price_per_sqft_cents: Number(zone.price_per_sqft_cents ?? 0),
      price_per_acre_cents: zone.price_per_acre_cents ?? 0,
      area_min_charge_cents: zone.area_min_charge_cents ?? 0,
      area_max_charge_cents: zone.area_max_charge_cents ?? null,
    },
    { dogCount: dogs, boundaryAreaSqm: subject.boundaryAreaSqm ?? null, multiplier: mult },
  );
  const areaPriced = (zone.pricing_mode ?? "flat") !== "flat";
  const extra = Math.max(0, dogs - 1) * (zone.per_dog_addl_cents ?? 0);
  const area = r.perVisitCents - (zone.base_price_cents ?? 0) - extra;
  return {
    id: `zone:${zone.id}`,
    source: "zone",
    zoneId: zone.id,
    label: zone.name,
    note:
      areaPriced && !subject.boundaryAreaSqm
        ? `Priced from ${zone.name}. The yard is not measured yet, so this is the base price without the area charge.`
        : `Priced from ${zone.name}`,
    priceCents: r.recurringCents,
    description: `${VISIT_WORDS[frequency]}, ${dogsWord(dogs)}`,
    breakdown:
      `${money(zone.base_price_cents ?? 0)} base` +
      (area > 0
        ? ` + ${money(area)} yard size${r.areaCapped ? " (at the zone's maximum)" : ""}`
        : "") +
      (extra > 0 ? ` + ${money(extra)} for ${dogsWord(dogs - 1)} more` : "") +
      multNote,
  };
}

/** The standard price for this subject, or null when none is set or the
 *  account is commercial (standard pricing is per-dog residential math). */
export function standardChoice(
  subject: QuoteSubject,
  standard: QuoteStandardPricing | null,
): PricingChoice | null {
  if (!standard || standard.basePriceCents == null) return null;
  if (subject.accountType === "commercial") return null;
  const frequency = quoteFrequency(subject.frequency);
  const mult = Number(standard.frequencyMultipliers?.[frequency] ?? 1) || 1;
  const dogs = Math.max(1, Math.min(20, Math.round(subject.dogCount ?? 1)));
  const extra = Math.max(0, dogs - 1) * (standard.perDogAddlCents ?? 0);
  return {
    id: "standard",
    source: "standard",
    zoneId: null,
    label: "Standard pricing",
    note: "Priced from your standard pricing",
    priceCents: Math.round((standard.basePriceCents + extra) * mult),
    description: `${VISIT_WORDS[frequency]}, ${dogsWord(dogs)}`,
    breakdown:
      `${money(standard.basePriceCents)} base` +
      (extra > 0 ? ` + ${money(extra)} for ${dogsWord(dogs - 1)} more` : "") +
      (mult !== 1 ? `, x${mult} for ${VISIT_WORDS[frequency].toLowerCase()}s` : ""),
  };
}

/** The zone that applies to this subject, by the rules at the top. */
export function zoneForSubject<Z extends QuotePricingZone>(
  zones: Z[],
  subject: QuoteSubject,
): Z | null {
  if (subject.zoneId) {
    const stored = zones.find((z) => z.id === subject.zoneId);
    if (stored) return stored;
  }
  if (!subject.postalCode && !subject.point) return null;
  return matchZone(zones, {
    postalCode: subject.postalCode ?? null,
    point: subject.point ?? null,
    accountType: subject.accountType ?? null,
  });
}

/**
 * The price to start the quote's service line from, or null when the app has
 * no price to offer. The matched zone when it has a price for this account's
 * kind; otherwise the standard price.
 */
export function suggestedServicePrice(
  zones: QuotePricingZone[],
  standard: QuoteStandardPricing | null,
  subject: QuoteSubject,
): PricingChoice | null {
  const zone = zoneForSubject(zones, subject);
  const fromZone = zone ? zoneChoice(zone, subject, standard) : null;
  return fromZone ?? standardChoice(subject, standard);
}

/** Every price the owner has set, for the "Add service from pricing" picker:
 *  the matched zone first, then the standard price, then the other zones by
 *  name. Zones with no price of the account's kind are left out. */
export function pricingChoices(
  zones: QuotePricingZone[],
  standard: QuoteStandardPricing | null,
  subject: QuoteSubject,
): PricingChoice[] {
  const matched = zoneForSubject(zones, subject);
  const out: PricingChoice[] = [];
  const first = matched ? zoneChoice(matched, subject, standard) : null;
  if (first) out.push(first);
  const std = standardChoice(subject, standard);
  if (std) out.push(std);
  for (const z of [...zones].sort((a, b) => a.name.localeCompare(b.name))) {
    if (matched && z.id === matched.id) continue;
    const c = zoneChoice(z, subject, standard);
    if (c) out.push(c);
  }
  return out;
}

/** A choice as the editor's line strings, which its own parsers read back. */
export function choiceToLine(choice: PricingChoice): {
  description: string;
  quantity: string;
  price: string;
  recurring: true;
} {
  return {
    description: choice.description,
    quantity: "1",
    price: (choice.priceCents / 100).toFixed(2),
    recurring: true,
  };
}
