/** What a booking link adds to a service's base price (#560): the line's
 *  add-ons, and a size per pet where the service prices by size.
 *
 *  Brendan, 2026-10-28: walking, training and grooming each get a self-serve
 *  path on the booking link, with a base price and add-ons ("dog breed,
 *  size"). Both already exist for the office:
 *
 *    add-ons         addon_services, tagged with the line they belong to
 *                    (Settings -> Add-ons). Only a line's own add-ons are
 *                    offered: an untagged one is a pet-waste extra, and a
 *                    pet-waste form is unchanged.
 *    size per pet    service_size_rules, a mobile groom's price for a size
 *                    (and optionally a coat). Breed is the pet row's own box.
 *
 *  The price is the office's rule, groomQuote in lib/groom.ts, run on the
 *  SERVER with rows it read itself. The browser sends ids and sizes, never a
 *  number of cents (signup.functions.ts). This file is pure, so the form, the
 *  server functions and the tests read one copy. English only: a customer
 *  reads it. */

import { groomQuote, PET_SIZES, PET_SIZE_LABEL, type PetSize } from "@/lib/groom";
import { serviceLinesOrDefault, type ServiceLine } from "@/lib/service-lines";

/** One add-on a stranger may pick: its line, its name and its price per
 *  visit. No organization column. */
export type PublicAddOn = {
  id: string;
  name: string;
  service_line: ServiceLine;
  unit_price_cents: number;
};

/** One size price on a service. */
export type PublicSizePrice = {
  service_id: string;
  size: PetSize;
  price_cents: number;
};

export type BookingExtras = { addOns: PublicAddOn[]; sizePrices: PublicSizePrice[] };

export const NO_EXTRAS: BookingExtras = { addOns: [], sizePrices: [] };

/** The most add-ons one request may name. More than any business lists. */
export const MAX_ADD_ONS = 20;

function isPetSize(v: unknown): v is PetSize {
  return typeof v === "string" && (PET_SIZES as readonly string[]).includes(v);
}

/** The rows the server read, typed. Add-ons: active, on one of `lines` and
 *  not pet waste, priced. Size prices: one per service and size, the price
 *  with no coat named (a coat is the groomer's call at the van, not a
 *  stranger's), only for `serviceIds`. Anything malformed is dropped. */
export function bookingExtrasFromRows(
  addOnRows: unknown,
  sizeRows: unknown,
  lines: readonly ServiceLine[],
  serviceIds: readonly string[],
): BookingExtras {
  const addOns: PublicAddOn[] = [];
  if (Array.isArray(addOnRows)) {
    for (const r of addOnRows) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      if (typeof o.id !== "string" || typeof o.name !== "string") continue;
      if (o.active === false) continue;
      const line = serviceLinesOrDefault([o.service_line])[0];
      if (o.service_line !== line || line === "pet_waste" || !lines.includes(line)) continue;
      if (typeof o.unit_price_cents !== "number" || o.unit_price_cents < 0) continue;
      if (addOns.some((a) => a.id === o.id)) continue;
      addOns.push({
        id: o.id,
        name: o.name,
        service_line: line,
        unit_price_cents: o.unit_price_cents,
      });
    }
  }
  addOns.sort((a, b) => a.name.localeCompare(b.name));

  const sizePrices: PublicSizePrice[] = [];
  if (Array.isArray(sizeRows)) {
    for (const r of sizeRows) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      if (typeof o.service_id !== "string" || !serviceIds.includes(o.service_id)) continue;
      if (!isPetSize(o.size) || o.coat_type != null) continue;
      if (typeof o.price_cents !== "number" || o.price_cents < 0) continue;
      if (sizePrices.some((s) => s.service_id === o.service_id && s.size === o.size)) continue;
      sizePrices.push({ service_id: o.service_id, size: o.size, price_cents: o.price_cents });
    }
  }
  sizePrices.sort((a, b) => PET_SIZES.indexOf(a.size) - PET_SIZES.indexOf(b.size));
  return { addOns, sizePrices };
}

/** The add-ons offered with this service: its line's. None for pet waste or
 *  for no service chosen, so the scooping form is the form it always was. */
export function addOnsFor(
  extras: BookingExtras,
  chosen: { service_line: ServiceLine } | null,
): PublicAddOn[] {
  if (!chosen || chosen.service_line === "pet_waste") return [];
  return extras.addOns.filter((a) => a.service_line === chosen.service_line);
}

/** The sizes this service prices by, smallest first. Empty when it prices
 *  every pet the same, and then no size is asked. */
export function sizePricesFor(
  extras: BookingExtras,
  chosen: { id: string } | null,
): PublicSizePrice[] {
  if (!chosen) return [];
  return extras.sizePrices.filter((s) => s.service_id === chosen.id);
}

/** How a size reads in the select and on the quote. */
export function petSizeLabel(size: PetSize): string {
  return PET_SIZE_LABEL[size];
}

/** The sizes as sent, one per pet, each a size or "" (not given). Anything
 *  else is "", and the list is cut to the pet count. */
export function cleanPetSizes(raw: unknown, count: number): (PetSize | "")[] {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from({ length: Math.max(0, count) }, (_, i) => (isPetSize(list[i]) ? list[i] : ""));
}

/** The add-on ids as sent: unique, at most MAX_ADD_ONS. */
export function cleanAddOnIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v): v is string => typeof v === "string"))].slice(0, MAX_ADD_ONS);
}

/** One line of the price, as the quote panel lists it. */
export type ExtraLine = { label: string; cents: number; addOn: boolean };

export type PricedVisit = {
  /** What one visit costs with the extras, or null when it cannot be priced
   *  (a pet with no size price and no base price to fall back on). */
  perVisitCents: number | null;
  /** The parts, in order: the service (or each pet), then each add-on. Empty
   *  when there is nothing to break down (no extras). */
  lines: ExtraLine[];
  /** The add-ons, by name, for the office's note. */
  addOnNames: string[];
};

/**
 * One visit of `service` with the extras, priced by the office's rule.
 *
 * `baseCents` is what public_quote said one visit costs for these pets. With
 * no size prices it stands, and the add-ons are added to it. With size
 * prices, each pet is priced by groomQuote: its size's price, or the
 * service's own base (and extra-pet) price when no size was given or that
 * size has no price. A pet with neither is unpriced, and so is the visit.
 */
export function priceVisitWithExtras(input: {
  service: {
    name: string;
    price_unit: "visit" | "hour" | "night";
    base_price_cents: number | null;
    extra_pet_cents: number;
    default_duration_min: number | null;
  };
  baseCents: number | null;
  petCount: number;
  sizes: readonly (PetSize | "")[];
  sizePrices: readonly PublicSizePrice[];
  addOns: readonly PublicAddOn[];
}): PricedVisit {
  const addOnLines = input.addOns.map((a) => ({
    label: a.name,
    cents: a.unit_price_cents,
    addOn: true,
  }));
  const addOnCents = addOnLines.reduce((sum, l) => sum + l.cents, 0);
  const addOnNames = input.addOns.map((a) => a.name);

  if (input.sizePrices.length === 0) {
    const perVisitCents = input.baseCents == null ? null : input.baseCents + addOnCents;
    const lines =
      addOnLines.length > 0 && input.baseCents != null
        ? [{ label: "Base price", cents: input.baseCents, addOn: false }, ...addOnLines]
        : [];
    return { perVisitCents, lines, addOnNames };
  }

  const count = Math.max(1, Math.floor(input.petCount) || 1);
  const pets = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    name: `Pet ${i + 1}`,
    size: (input.sizes[i] || null) as PetSize | null,
    coat_type: null,
  }));
  const q = groomQuote({
    service: input.service,
    rules: input.sizePrices.map((s) => ({
      size: s.size,
      coat_type: null,
      duration_min: 0,
      price_cents: s.price_cents,
    })),
    pets,
    addons: input.addOns.map((a) => ({
      id: a.id,
      name: a.name,
      unit_price_cents: a.unit_price_cents,
      duration_min: 0,
      quantity: 1,
    })),
  });
  if (q.cents == null) return { perVisitCents: null, lines: [], addOnNames };
  const petLines = q.pets.map((p) => ({
    label: `${count > 1 ? `${p.name}: ` : ""}${p.size ? petSizeLabel(p.size) : "Size not given"}`,
    cents: p.cents ?? 0,
    addOn: false,
  }));
  return { perVisitCents: q.cents, lines: [...petLines, ...addOnLines], addOnNames };
}

/** What the office reads about the extras on the lead: "Add-ons: Teeth
 *  brushing, Nail grind. Sizes: small, large." Null when there are none. */
export function extrasNote(
  addOnNames: readonly string[],
  sizes: readonly (PetSize | "")[],
): string | null {
  const parts: string[] = [];
  if (addOnNames.length) parts.push(`Add-ons: ${addOnNames.join(", ")}.`);
  const given = sizes.filter((s): s is PetSize => !!s);
  if (given.length)
    parts.push(`Sizes: ${given.map((s) => petSizeLabel(s).toLowerCase()).join(", ")}.`);
  return parts.length ? parts.join(" ") : null;
}

/** The visitor's note with the extras after it, for the lead's message. */
export function messageWithExtras(message: string | null | undefined, note: string | null): string {
  const m = (message ?? "").trim();
  if (!note) return m;
  return (m ? `${m}\n\n${note}` : note).slice(0, 2000);
}
