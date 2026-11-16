// What Zones > New zone starts with, and what it leaves behind (#914).
//
// Three things a new owner hit on their first zone, each decided here so the
// drawer, the server and the tests share one copy:
//
//   1. THE PRICE. A new zone's price field is an override (#860): blank means
//      "charge the standard price", and the field shows that price greyed in.
//      That is right whenever a standard price exists. When none does -- the
//      guided setup step that would have set it failed before it got there
//      (#881) -- blank charged nothing, and the price the owner had just typed
//      into setup was still sitting in that step's draft on this device. So
//      the drawer offers THAT number, and only then. With neither, it stays
//      blank and says the standard is not set; it never invents one. (Until
//      #860 it invented $25 + $5.)
//
//   2. THE BUSINESS'S OWN ZIP. "Inside" a circle means the ZIP's Census center
//      is inside (zone-zip-fill.ts), and a one-mile circle in a city usually
//      holds none -- Lansing's 48933 is a ZIP 928 m across. The save already
//      lists the ZIP the circle's middle sits in when nothing is inside (#858),
//      but the drawer said "No ZIP has its center inside the circle" and
//      showed no chip, so the owner typed it by hand. Now the drawer adds what
//      the save would, and, for a circle that holds the business's own
//      address, the business's ZIP -- which is the one ZIP an owner knows
//      should be there and the one centers alone can miss.
//
//   3. THE LIST. Create closed the drawer and only marked the Zones list
//      stale; the list kept the old answer until a refetch of listZones (which
//      also retries pending ZIP fills and pages active clients) came back, and
//      kept it for good if that refetch failed. The new zone now goes into the
//      list the moment Create succeeds, and the refetch reconciles it.

import { matchZone } from "./zone-match";
import { zoneFromShape, type ZoneShapeInput } from "./zone-zip-fill";

// ── 1. The price ──────────────────────────────────────────────────────────

/** The two fields of setup's service-area step this reads from its draft. */
export type SetupAreaPriceDraft = { price?: unknown; extraDog?: unknown } | null | undefined;

export type NewZonePriceDefault = {
  /** What the base price field starts with. "" is "charge the standard". */
  basePrice: string;
  /** What the extra-dog field starts with. */
  perDog: string;
  /** Where it came from: the standard price (shown as the placeholder, the
   *  field left blank), setup's typed price, or nothing. */
  source: "standard" | "setup" | "none";
};

/** A dollar amount as the drawer's money fields hold it, or null. */
function dollars(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n <= 10_000 ? n.toFixed(2) : null;
}

/**
 * A NEW zone's starting price. `standardBaseCents` is getStandardPricing's
 * answer: undefined while it is loading, null when there is no standard.
 */
export function newZonePriceDefault(
  standardBaseCents: number | null | undefined,
  setupDraft: SetupAreaPriceDraft,
): NewZonePriceDefault {
  // A standard price exists: the field stays blank and shows it. A copy here
  // would be an override that stops following Settings → Services (#860).
  if (standardBaseCents != null) return { basePrice: "", perDog: "", source: "standard" };
  if (standardBaseCents === undefined) return { basePrice: "", perDog: "", source: "none" };
  const base = dollars(setupDraft?.price);
  if (base) {
    return { basePrice: base, perDog: dollars(setupDraft?.extraDog) ?? "0.00", source: "setup" };
  }
  return { basePrice: "", perDog: "", source: "none" };
}

// ── 2. The business's own ZIP ─────────────────────────────────────────────

/** The five-digit ZIP at the end of a one-line US address, or null. The LAST
 *  five-digit run, so a street number like "48933 Main St" is not taken for
 *  it when a real ZIP follows. */
export function businessZipFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const runs = Array.from(String(address).matchAll(/(?:^|[^\d])(\d{5})(?:-\d{4})?(?![\d])/g));
  if (runs.length === 0) return null;
  // A lone run at the very start is a house number, not a ZIP.
  const last = runs[runs.length - 1];
  if (runs.length === 1 && String(address).trim().startsWith(last[1])) return null;
  return last[1];
}

export type BusinessPlace = { lat: number; lng: number; zip: string | null } | null | undefined;

export type NewZoneZips = {
  /** What the drawer fills the list with: the ZIPs inside, plus the extras. */
  zips: string[];
  /** Nothing was inside, so the ZIP at the middle was added (as the save
   *  does, #858). */
  centerZip: string | null;
  /** The business's address is inside the shape and its ZIP was not. */
  businessZip: string | null;
};

/**
 * The ZIPs a NEW zone's shape should list: every ZIP whose center is inside
 * (`inside`, from zipsInZoneShape), the ZIP the middle sits in when none is
 * (`centerZip`, the same answer the save gives), and the business's own ZIP
 * when the business's address is inside the shape -- decided by matchZone,
 * the same call that assigns a property to a zone, so "the business is in
 * this circle" means what it means everywhere else.
 */
export function newZoneZips(
  shape: ZoneShapeInput | null | undefined,
  inside: string[],
  centerZip: string | null | undefined,
  business: BusinessPlace,
): NewZoneZips {
  const zips = [...inside];
  let center: string | null = null;
  if (zips.length === 0 && centerZip) {
    zips.push(centerZip);
    center = centerZip;
  }
  let biz: string | null = null;
  const zone = zoneFromShape(shape);
  if (
    zone &&
    business?.zip &&
    !zips.includes(business.zip) &&
    matchZone([zone], { point: { lat: business.lat, lng: business.lng } })
  ) {
    zips.push(business.zip);
    biz = business.zip;
  }
  return { zips, centerZip: center, businessZip: biz };
}

// ── 3. The list ───────────────────────────────────────────────────────────

/** listZones' answer, as the Zones page caches it under ["zones"]. */
export type ZonesListData = { zones?: Array<Record<string, unknown>>; [k: string]: unknown };

/** The Zones list's cached answer with a just-created zone in it. Nothing
 *  cached yet: left alone, the refetch draws it. Already there: replaced. */
export function withCreatedZone<T extends ZonesListData | undefined>(
  old: T,
  zone: Record<string, unknown> | null | undefined,
): T {
  if (!old || !zone || typeof zone.id !== "string") return old;
  const rest = (old.zones ?? []).filter((z) => z.id !== zone.id);
  return { ...old, zones: [...rest, zone] } as T;
}
