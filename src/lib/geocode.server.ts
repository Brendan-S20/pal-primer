// Server-only geocoding via OpenStreetMap Nominatim.
//
// Usage policy: https://operations.osmfoundation.org/policies/nominatim/
//   - Max 1 request/second (this module enforces a simple in-process throttle).
//   - Provide a descriptive User-Agent identifying the app + contact.
//   - Not intended for bulk/heavy production loads. If HoundStack signup or
//     property-import volume grows past ~1 req/sec sustained, switch to a
//     paid provider (LocationIQ, Mapbox, Google) or a self-hosted Nominatim.

/** How precisely the geocoder actually matched.
 *
 *  ── WHY THIS EXISTS ────────────────────────────────────────────────────
 *
 *  Nominatim answers a house it does not know by returning the STREET, or the
 *  city, and the shape of the reply is identical either way. Until this, the
 *  caller received {latitude, longitude} and had no way to tell a driveway
 *  from a town centre, so a street centroid was stored as though somebody
 *  lived on it -- and on a long suburban road that is hundreds of metres from
 *  the actual house, which is the difference between a technician finding it
 *  and phoning the office.
 *
 *  Measured against six ordinary US addresses on 2026-08-26: two matched a
 *  house, two returned the street only, two missed entirely. So the imprecise
 *  answer is the COMMON case in the United States, not the edge case, and it
 *  was indistinguishable from the good one. */
export type GeocodePrecision = "house" | "street" | "area";

export type GeocodeResult =
  | { latitude: number; longitude: number; precision: GeocodePrecision }
  | null;

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT =
  "HoundStack/1.0 (pet-waste operations app; contact: support@houndstack.com)";

// In-process 1 req/s throttle. Sufficient for interactive onboarding flows;
// not sufficient for concurrent bulk imports across multiple workers.
let lastRequestAt = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastRequestAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

export async function geocodeAddress(parts: {
  street?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
}): Promise<GeocodeResult> {
  const address = [parts.street, parts.city, parts.region, parts.postal_code, parts.country]
    .filter(Boolean)
    .join(", ")
    .trim();
  if (!address) return null;

  await throttle();

  // addressdetails=1, so the reply says WHICH part it matched. It used to be
  // 0, which made a house and a city centre arrive looking the same.
  //
  // countrycodes, because nothing else told Nominatim which country to search,
  // and plenty of US towns share a name with somewhere abroad (Paris, Athens,
  // Dublin, Rome, Victoria). A sparse or misspelt address could resolve to the
  // wrong continent -- and the routing trials showed what one such point did:
  // a single leg past what visits.travel_km can hold, and auto-routing refused
  // the WHOLE day for every technician with "numeric field overflow"
  // (20261002090200 now survives it; this stops producing it). The product
  // serves the US, and Canada is the only other market in view.
  const url = `${NOMINATIM_URL}?format=json&limit=1&addressdetails=1&countrycodes=us,ca&q=${encodeURIComponent(address)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });
  } catch (err) {
    console.error("[geocode] network error for address", address, err);
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[geocode] Nominatim ${res.status} for address "${address}": ${body.slice(0, 300)}`,
    );
    return null;
  }

  let data: any;
  try {
    data = await res.json();
  } catch (err) {
    console.error("[geocode] invalid JSON from Nominatim for address", address, err);
    return null;
  }

  const first = Array.isArray(data) ? data[0] : null;
  const lat = first?.lat != null ? Number(first.lat) : NaN;
  const lon = first?.lon != null ? Number(first.lon) : NaN;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const detail = (first as any)?.address ?? {};
    const precision: GeocodePrecision = detail.house_number
      ? "house"
      : detail.road
        ? "street"
        : "area";
    if (precision !== "house") {
      // Not an error, and deliberately not a refusal: a street-level point is
      // far better than nothing for routing, and refusing it would block a
      // signup over a road OSM has not house-numbered. It has to be VISIBLE.
      console.warn(`[geocode] ${precision}-level match only for "${address}"`);
    }
    return { latitude: lat, longitude: lon, precision };
  }

  console.warn(`[geocode] no result for address "${address}"`);
  return null;
}
