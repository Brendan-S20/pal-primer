// Server-only geocoding via OpenStreetMap Nominatim.
//
// Usage policy: https://operations.osmfoundation.org/policies/nominatim/
//   - Max 1 request/second (this module enforces a simple in-process throttle).
//   - Provide a descriptive User-Agent identifying the app + contact.
//   - Not intended for bulk/heavy production loads. If HoundStack signup or
//     property-import volume grows past ~1 req/sec sustained, switch to a
//     paid provider (LocationIQ, Mapbox, Google) or a self-hosted Nominatim.

export type GeocodeResult = { latitude: number; longitude: number } | null;

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

  const url = `${NOMINATIM_URL}?format=json&limit=1&addressdetails=0&q=${encodeURIComponent(address)}`;

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
    return { latitude: lat, longitude: lon };
  }

  console.warn(`[geocode] no result for address "${address}"`);
  return null;
}
