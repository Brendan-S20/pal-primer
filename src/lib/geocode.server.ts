// Server-only geocoding. Geocodio when GEOCODIO_API_KEY is set, OpenStreetMap
// Nominatim when it is not -- and Nominatim again whenever Geocodio errors.
//
// Nominatim usage policy: https://operations.osmfoundation.org/policies/nominatim/
//   - Max 1 request/second (this module enforces a simple in-process throttle).
//   - Provide a descriptive User-Agent identifying the app + contact.
//   - Not intended for bulk/heavy production loads. That is the reason for the
//     Geocodio branch: a 500-row import is 500 seconds against Nominatim and
//     one request against Geocodio's batch endpoint (geocodeAddresses below).
//
// Geocodio: https://www.geocod.io/docs/ -- US and Canada only, which is also
// exactly where this product's customers are. Its API key has to travel as the
// `api_key` QUERY PARAMETER; that is acceptable server-side, but it means the
// request URL is a secret. It is never logged, and every message built from a
// Geocodio response goes through redact() first.
//
// Since #529 both are ADAPTERS (GeocodingAdapter, below), chosen by
// configuration -- see src/lib/providers/config.ts:
//
//   GEOCODING_PROVIDER  unset: "geocodio" when GEOCODIO_API_KEY is set, else
//                       "nominatim" -- the rule this file always followed.
//   GEOCODING_FALLBACK  who is asked when the first provider fails to answer.
//                       Unset: "nominatim", as before. "none": nobody; the
//                       address simply gets no point.
//   GEOCODING_API_KEY / GEOCODING_URL  handed to whichever adapter is picked.
//
// A paid provider is a new entry in GEOCODING_PROVIDERS. Nothing that calls
// geocodeAddress or geocodeAddresses changes.
import {
  adapterFor,
  envValue,
  providerContext,
  requestedProvider,
  serverEnv,
  type ProviderContext,
  type ProviderEnv,
} from "@/lib/providers/config";

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
  | {
      latitude: number;
      longitude: number;
      precision: GeocodePrecision;
      /** The town the match is in (city, town, village or suburb), when the
       *  reply names one. Used to suggest a name for a new zone. */
      place?: string | null;
    }
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

export type AddressParts = {
  street?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
};

function joinAddress(parts: AddressParts): string {
  return [parts.street, parts.city, parts.region, parts.postal_code, parts.country]
    .filter(Boolean)
    .join(", ")
    .trim();
}

// ── The provider ────────────────────────────────────────────────────────────

/** "This provider did not answer" -- an outage, a bad key, a 429 -- as
 *  distinct from null, "it answered, and there is no usable point". Only the
 *  first sends the address on to the fallback. */
export const GEOCODER_FAILED = Symbol("geocoder-failed");
export type GeocoderAnswer = GeocodeResult | typeof GEOCODER_FAILED;

export type GeocodingAdapter = {
  id: string;
  /** One address. `parts` is there for anything the joined string loses
   *  (Geocodio is told the country). */
  single(address: string, parts: AddressParts, ctx: ProviderContext): Promise<GeocoderAnswer>;
  /** Many addresses, answers in input order. Optional: without it, rows are
   *  asked one at a time through `single`. */
  batch?(addresses: string[], ctx: ProviderContext): Promise<GeocoderAnswer[] | typeof GEOCODER_FAILED>;
  /** Asked one address at a time under a rate limit, so a caller's time
   *  budget (`nominatimBudgetMs`) applies to it. */
  throttled?: boolean;
};

const geocodio: GeocodingAdapter = {
  id: "geocodio",
  async single(address, parts, ctx) {
    const key = geocodioKey(ctx);
    if (!key) {
      console.error(`[geocode] geocodio selected but no GEOCODIO_API_KEY / GEOCODING_API_KEY; falling back`);
      return GEOCODER_FAILED;
    }
    return geocodioSingle(address, geocodioCountry(parts), key);
  },
  async batch(addresses, ctx) {
    const key = geocodioKey(ctx);
    if (!key) {
      console.error(`[geocode] geocodio selected but no GEOCODIO_API_KEY / GEOCODING_API_KEY; falling back`);
      return GEOCODER_FAILED;
    }
    const out: GeocoderAnswer[] = [];
    for (let at = 0; at < addresses.length; at += GEOCODIO_BATCH_MAX) {
      const chunk = addresses.slice(at, at + GEOCODIO_BATCH_MAX);
      const answers = await geocodioBatch(chunk, key);
      if (answers === GEOCODER_FAILED) chunk.forEach(() => out.push(GEOCODER_FAILED));
      else out.push(...answers);
    }
    return out;
  },
};

const nominatim: GeocodingAdapter = {
  id: "nominatim",
  throttled: true,
  // Never GEOCODER_FAILED: it has always been the last resort, so its
  // failures are a null, logged where they happen.
  single: (address) => geocodeWithNominatim(address),
};

const GEOCODING_PROVIDERS = new Map<string, GeocodingAdapter>([
  [geocodio.id, geocodio],
  [nominatim.id, nominatim],
]);

/** Add (or replace) a geocoding adapter; GEOCODING_PROVIDER or
 *  GEOCODING_FALLBACK then select it by id. */
export function registerGeocodingProvider(adapter: GeocodingAdapter): void {
  GEOCODING_PROVIDERS.set(adapter.id.toLowerCase(), adapter);
}

/** Remove an adapter registered with registerGeocodingProvider. The two
 *  built-ins stay. */
export function unregisterGeocodingProvider(id: string): void {
  const k = id.toLowerCase();
  if (k !== geocodio.id && k !== nominatim.id) GEOCODING_PROVIDERS.delete(k);
}

/** Who is asked first, and who is asked when that one does not answer.
 *  Throws ProviderConfigError for a name nobody registered. */
export function geocodingProviders(env: ProviderEnv = serverEnv()): {
  primary: GeocodingAdapter;
  fallback: GeocodingAdapter | null;
} {
  const primary = adapterFor(
    "geocoding",
    GEOCODING_PROVIDERS,
    requestedProvider("geocoding", env, envValue(env, "GEOCODIO_API_KEY") ? geocodio.id : nominatim.id),
  );
  const fb = (envValue(env, "GEOCODING_FALLBACK") ?? nominatim.id).toLowerCase();
  if (fb === "none" || fb === "off" || fb === primary.id) return { primary, fallback: null };
  return {
    primary,
    fallback: adapterFor("geocoding", GEOCODING_PROVIDERS, fb, "GEOCODING_FALLBACK"),
  };
}

/** geocodingProviders, or null with the reason logged: a misconfigured
 *  geocoder costs a pin, never a signup. */
function chainOrNull() {
  try {
    return geocodingProviders();
  } catch (err) {
    console.error("[geocode]", (err as Error).message, "No address will get a point.");
    return null;
  }
}

/** Geocode one address with the configured provider, and its fallback if the
 *  provider does not answer. Unconfigured: Geocodio if a key is set,
 *  otherwise -- or if Geocodio errors -- Nominatim, exactly as before. */
export async function geocodeAddress(parts: AddressParts): Promise<GeocodeResult> {
  const address = joinAddress(parts);
  if (!address) return null;

  const chain = chainOrNull();
  if (!chain) return null;
  const ctx = providerContext("geocoding", serverEnv());

  const answer = await chain.primary.single(address, parts, ctx);
  if (answer !== GEOCODER_FAILED) return answer;
  // A bad key, a 429 or an outage must not stop a signup from getting a pin:
  // the fallback is slower, not wrong. Unless there is no fallback, by choice.
  if (!chain.fallback) {
    console.error(`[geocode] ${chain.primary.id} did not answer for "${address}" and GEOCODING_FALLBACK is none`);
    return null;
  }
  const second = await chain.fallback.single(address, parts, ctx);
  return second === GEOCODER_FAILED ? null : second;
}

/** Geocode many addresses, answers in the SAME ORDER as the input, one entry
 *  per input (null where nothing usable came back -- the same null a single
 *  lookup returns, so callers keep treating "no coordinates" one way).
 *
 *  A provider with a batch endpoint (Geocodio: one request per 10,000
 *  addresses) is asked once; one without is asked row by row. Rows the first
 *  provider did not answer -- a whole failed batch, or one row's error -- go
 *  to the fallback. Unconfigured, that is exactly the old behaviour: Geocodio
 *  batches with a key, Nominatim at 1/s without one or for what it missed. */
export async function geocodeAddresses(
  list: AddressParts[],
  opts: {
    /** Stop asking a throttled provider (Nominatim) after this long; rows it
     *  did not reach come back null, the same as an address with no match.
     *  Unset: no limit. An import sets it (#617) because 1,000 addresses at
     *  one a second is about 17 minutes. */
    nominatimBudgetMs?: number;
  } = {},
): Promise<GeocodeResult[]> {
  const out: GeocodeResult[] = list.map(() => null);
  const addresses = list.map(joinAddress);
  const chain = chainOrNull();
  if (!chain) return out;
  const ctx = providerContext("geocoding", serverEnv());

  /** Ask `adapter` for every row in `rows`; returns the rows it did not answer. */
  const ask = async (adapter: GeocodingAdapter, rows: number[]): Promise<number[]> => {
    const missed: number[] = [];
    if (rows.length === 0) return missed;
    if (adapter.batch) {
      const answers = await adapter.batch(rows.map((i) => addresses[i]), ctx);
      rows.forEach((rowIndex, k) => {
        const a = answers === GEOCODER_FAILED ? GEOCODER_FAILED : answers[k];
        if (a === GEOCODER_FAILED || a === undefined) missed.push(rowIndex);
        else out[rowIndex] = a;
      });
      return missed;
    }
    const deadline =
      adapter.throttled && opts.nominatimBudgetMs != null
        ? Date.now() + opts.nominatimBudgetMs
        : Infinity;
    for (const i of rows) {
      if (Date.now() >= deadline) break;
      const a = await adapter.single(addresses[i], list[i], ctx);
      if (a === GEOCODER_FAILED) missed.push(i);
      else out[i] = a;
    }
    return missed;
  };

  const wanted = addresses.flatMap((a, i) => (a ? [i] : []));
  const missed = await ask(chain.primary, wanted);
  if (missed.length && chain.fallback) await ask(chain.fallback, missed);
  else if (missed.length) {
    console.error(
      `[geocode] ${chain.primary.id} did not answer ${missed.length} address(es) and GEOCODING_FALLBACK is none`,
    );
  }
  return out;
}

// ── Geocodio ────────────────────────────────────────────────────────────────

const GEOCODIO_URL = "https://api.geocod.io/v1.7/geocode";
// The documented ceiling for one batch request.
const GEOCODIO_BATCH_MAX = 10_000;
// A sentinel distinct from null: null is "Geocodio answered, and the answer is
// that there is no usable point"; GEOCODIO_FAILED is "Geocodio did not answer"
// and the caller should ask the fallback instead.
const GEOCODIO_FAILED: typeof GEOCODER_FAILED = GEOCODER_FAILED;
type GeocodioAnswer = GeocoderAnswer;

/** GEOCODIO_API_KEY first -- its own name, which means only Geocodio -- then
 *  the generic GEOCODING_API_KEY. */
function geocodioKey(ctx: ProviderContext): string | null {
  return envValue(ctx.env, "GEOCODIO_API_KEY") ?? ctx.key;
}

/** Remove any configured key from anything about to be logged. Geocodio's
 *  error bodies do not echo it today; this is so that a future one that does
 *  cannot leak it. */
function redact(text: string): string {
  let out = text;
  for (const name of ["GEOCODIO_API_KEY", "GEOCODING_API_KEY"]) {
    const key = envValue(serverEnv(), name);
    if (key) out = out.split(key).join("[redacted]");
  }
  return out;
}

const CA_POSTAL = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/i;

/** "US" or "CA" when the parts say which, else null (let Geocodio detect it).
 *  Never anything else: Geocodio covers only those two, and so does the
 *  product. */
function geocodioCountry(parts: AddressParts): "US" | "CA" | null {
  const c = (parts.country ?? "").trim().toLowerCase();
  if (["us", "usa", "united states", "united states of america"].includes(c)) return "US";
  if (["ca", "can", "canada"].includes(c)) return "CA";
  if (CA_POSTAL.test(parts.postal_code ?? "")) return "CA";
  return null;
}

type GeocodioResult = {
  address_components?: { country?: string; city?: string };
  formatted_address?: string;
  location?: { lat?: number; lng?: number };
  accuracy?: number;
  accuracy_type?: string;
};

/** Below this, Geocodio itself is unsure the match is the address asked for.
 *  Its docs treat 0.8+ as a confident match. */
const GEOCODIO_CONFIDENT = 0.8;

/** Geocodio's accuracy_type, on the same three-step scale Nominatim's answer
 *  is reduced to.
 *
 *    house   rooftop, point, range_interpolation -- this house number. The
 *            last is interpolated along the block between known numbers,
 *            which is what most US house-level geocoding is; it lands on
 *            the right side of the right block.
 *    street  nearest_rooftop_match, intersection, street_center -- the
 *            first is a NEIGHBOUR's rooftop on the same street (the number
 *            asked for was not found), so it is not this house.
 *    area    place, county, state, and anything not listed here.
 *
 *  A house-level type with an accuracy score under 0.8 is reported as
 *  street: Geocodio found a house, but is not confident it is this one. */
function geocodioPrecision(r: GeocodioResult): GeocodePrecision {
  const type = r.accuracy_type ?? "";
  const score = typeof r.accuracy === "number" ? r.accuracy : 0;
  if (type === "rooftop" || type === "point" || type === "range_interpolation") {
    return score >= GEOCODIO_CONFIDENT ? "house" : "street";
  }
  if (type === "nearest_rooftop_match" || type === "intersection" || type === "street_center") {
    return "street";
  }
  return "area";
}

/** The best US/Canada point in one Geocodio response, or null. Results come
 *  sorted best-first; anything outside the two countries is rejected rather
 *  than stored, for the reason Nominatim is told `countrycodes=us,ca`. */
function pickGeocodio(address: string, results: unknown): GeocodeResult {
  const list = Array.isArray(results) ? (results as GeocodioResult[]) : [];
  for (const r of list) {
    const country = (r.address_components?.country ?? "").toUpperCase();
    if (country !== "US" && country !== "CA") continue;
    const lat = Number(r.location?.lat);
    const lon = Number(r.location?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const precision = geocodioPrecision(r);
    if (precision !== "house") {
      console.warn(
        `[geocode] ${precision}-level match only for "${address}" (geocodio ${r.accuracy_type ?? "?"} ${r.accuracy ?? "?"})`,
      );
    }
    // The town, for the same reason the Nominatim branch returns one: a new
    // zone is named after it (src/lib/zones.functions.ts).
    const place = r.address_components?.city ?? null;
    return { latitude: lat, longitude: lon, precision, place: place ? String(place) : null };
  }
  console.warn(
    list.length
      ? `[geocode] geocodio: no US/Canada result for "${address}"`
      : `[geocode] geocodio: no result for "${address}"`,
  );
  return null;
}

async function geocodioSingle(
  address: string,
  country: "US" | "CA" | null,
  key: string,
): Promise<GeocodioAnswer> {
  const params = new URLSearchParams({ q: address, api_key: key });
  if (country) params.set("country", country);
  let res: Response;
  try {
    res = await fetch(`${GEOCODIO_URL}?${params}`, { headers: { Accept: "application/json" } });
  } catch (err) {
    console.error(
      `[geocode] geocodio network error for "${address}"; falling back:`,
      redact(String((err as Error)?.message ?? err)),
    );
    return GEOCODIO_FAILED;
  }
  if (!res.ok) {
    // 403 bad key, 422 unparseable, 429 over quota, 5xx outage: all of them
    // are "ask somebody else", not "this address does not exist".
    const body = await res.text().catch(() => "");
    console.error(
      `[geocode] geocodio ${res.status} for "${address}"; falling back: ${redact(body.slice(0, 300))}`,
    );
    return GEOCODIO_FAILED;
  }
  let data: { results?: unknown } | null;
  try {
    data = await res.json();
  } catch {
    console.error(
      `[geocode] geocodio sent invalid JSON for "${address}"; falling back`,
    );
    return GEOCODIO_FAILED;
  }
  return pickGeocodio(address, data?.results);
}

/** One batch request. Answers in input order, or GEOCODIO_FAILED for the
 *  whole batch. Geocodio returns the batch in the order it was sent; each
 *  entry's `query` is checked against what was sent anyway, because a result
 *  attached to the wrong row is a pin on the wrong customer's house. */
async function geocodioBatch(
  addresses: string[],
  key: string,
): Promise<GeocodioAnswer[] | typeof GEOCODIO_FAILED> {
  const params = new URLSearchParams({ api_key: key });
  let res: Response;
  try {
    res = await fetch(`${GEOCODIO_URL}?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(addresses),
    });
  } catch (err) {
    console.error(
      `[geocode] geocodio batch of ${addresses.length}: network error; falling back:`,
      redact(String((err as Error)?.message ?? err)),
    );
    return GEOCODIO_FAILED;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[geocode] geocodio batch of ${addresses.length}: ${res.status}; falling back: ${redact(body.slice(0, 300))}`,
    );
    return GEOCODIO_FAILED;
  }
  let data: { results?: unknown } | null;
  try {
    data = await res.json();
  } catch {
    console.error(
      `[geocode] geocodio batch of ${addresses.length}: invalid JSON; falling back`,
    );
    return GEOCODIO_FAILED;
  }
  type BatchEntry = { query?: unknown; response?: { error?: unknown; results?: unknown } };
  const entries: BatchEntry[] = Array.isArray(data?.results) ? data.results : [];
  if (entries.length !== addresses.length) {
    console.error(
      `[geocode] geocodio batch sent ${addresses.length}, got ${entries.length} back; falling back`,
    );
    return GEOCODIO_FAILED;
  }
  return addresses.map((address, i): GeocodioAnswer => {
    const entry = entries[i];
    if (typeof entry?.query === "string" && entry.query !== address) {
      console.error(
        `[geocode] geocodio batch row ${i} answered a different query; falling back for "${address}"`,
      );
      return GEOCODIO_FAILED;
    }
    const response = entry?.response;
    if (!response || response.error) {
      // A per-row error (typically "could not parse this address") inside an
      // otherwise good batch: that row, and only that row, tries Nominatim.
      console.error(
        `[geocode] geocodio batch row ${i} error for "${address}"; falling back: ${redact(String(response?.error ?? "no response"))}`,
      );
      return GEOCODIO_FAILED;
    }
    return pickGeocodio(address, response.results);
  });
}

// ── Nominatim ───────────────────────────────────────────────────────────────

async function geocodeWithNominatim(address: string): Promise<GeocodeResult> {
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
    const place =
      detail.city ?? detail.town ?? detail.village ?? detail.suburb ?? detail.hamlet ?? null;
    return { latitude: lat, longitude: lon, precision, place: place ? String(place) : null };
  }

  console.warn(`[geocode] no result for address "${address}"`);
  return null;
}
