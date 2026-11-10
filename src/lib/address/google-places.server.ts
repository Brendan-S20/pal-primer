// Google Places API (New) implementation of AddressProvider.
//
// Uses the v1 REST endpoints (places:autocomplete + place details) with an
// API key read from GOOGLE_PLACES_API_KEY on the server. USA-only,
// address-first (street_address/premise/subpremise primary types), with an
// optional location bias circle around the workspace's service area.
// Google is ONLY used for address search; geocoding results feed the same
// OSM/Leaflet map stack as before.
import type {
  AddressProvider,
  AddressSuggestion,
  AddressDetails,
} from "@/lib/address/provider.server";
import { isCompletePick } from "@/lib/address/pick";
import { addressFromPlace, type PlaceComponent } from "@/lib/address/from-place";

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places";
const BIAS_RADIUS_METERS = 50_000;
const ADDRESS_TYPES = ["street_address", "premise", "subpremise"];

interface Prediction extends AddressSuggestion {
  types: string[];
}

/** One autocomplete call. Never throws: a failed call is an empty list, and
 *  the field is still an ordinary text input. */
async function requestPredictions(
  key: string,
  body: Record<string, unknown>,
): Promise<Prediction[]> {
  const res = await fetch(AUTOCOMPLETE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.warn("places autocomplete failed:", res.status, await res.text().catch(() => ""));
    return [];
  }
  const json = (await res.json()) as {
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string;
        distanceMeters?: number;
        types?: string[];
        structuredFormat?: {
          mainText?: { text?: string };
          secondaryText?: { text?: string };
        };
        text?: { text?: string };
      };
    }>;
  };
  const out: Prediction[] = [];
  for (const s of json.suggestions ?? []) {
    const p = s.placePrediction;
    if (!p?.placeId) continue;
    out.push({
      id: p.placeId,
      mainText: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
      secondaryText: p.structuredFormat?.secondaryText?.text ?? "",
      distanceMeters: typeof p.distanceMeters === "number" ? p.distanceMeters : null,
      types: p.types ?? [],
    });
  }
  return out;
}

/** A street line and at least one more part ("…, Lansing" / "… 48933"). */
export function looksLikeFullAddress(query: string): boolean {
  const q = query.trim();
  return /^\d+\s+\S/.test(q) && (q.includes(",") || /\b\d{5}(?:-\d{4})?\s*$/.test(q));
}

/** Still an address a form can be filled from: typed as one, or at least
 *  led by a house number. */
function isAddressLevel(p: Prediction): boolean {
  return p.types.some((t) => ADDRESS_TYPES.includes(t)) || /^\d+[A-Za-z]?\s/.test(p.mainText);
}

function apiKey(): string | undefined {
  return process.env.GOOGLE_PLACES_API_KEY || undefined;
}

export const googlePlacesProvider: AddressProvider = {
  name: "google-places",

  isConfigured() {
    return !!apiKey();
  },

  async autocomplete(query, opts) {
    const key = apiKey();
    if (!key) return [];
    const base: Record<string, unknown> = {
      input: query,
      includedRegionCodes: ["us"],
    };
    if (opts?.sessionToken) base.sessionToken = opts.sessionToken;
    if (opts?.bias) {
      const center = { latitude: opts.bias.latitude, longitude: opts.bias.longitude };
      base.locationBias = { circle: { center, radius: BIAS_RADIUS_METERS } };
      // `origin` is what makes Google return distanceMeters on each
      // prediction, which the server ranks and fences by (#783).
      base.origin = center;
    }

    // USA only, residential addresses first: restrict to precise
    // address-level primary types so house numbers outrank businesses.
    const strict = await requestPredictions(key, {
      ...base,
      includedPrimaryTypes: ADDRESS_TYPES,
    });
    if (strict.length > 0 || !looksLikeFullAddress(query)) return strict;

    // A whole address typed at once — "100 Main St, Lansing, MI 48933", the
    // way the setup step's business address is entered — can come back
    // empty under the primary-type restriction even when Google has the
    // address, because the prediction it would make is not typed with one of
    // those primary types. Setup step 1 showed no suggestions at all for one
    // (#783). Ask once more without the restriction, and keep only what is
    // still an address with a house number: a business or a bare street is
    // not something a pick could fill every part of a form from.
    const loose = await requestPredictions(key, base);
    return loose.filter(isAddressLevel);
  },

  async details(placeId, opts) {
    const key = apiKey();
    if (!key) return null;
    // Place ids are provider-controlled; keep the path strictly one segment.
    const safeId = encodeURIComponent(placeId);
    const url = new URL(`${DETAILS_URL}/${safeId}`);
    if (opts?.sessionToken) url.searchParams.set("sessionToken", opts.sessionToken);

    const res = await fetch(url, {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "addressComponents,location,formattedAddress",
      },
    });
    if (!res.ok) {
      console.warn("places details failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const json = (await res.json()) as {
      addressComponents?: PlaceComponent[];
      location?: { latitude?: number; longitude?: number };
      formattedAddress?: string;
    };
    // Components first, then the place's formatted address, then (for the
    // street line only) the row the person picked — all three describe this
    // one place (lib/address/from-place.ts, #805). A place with no
    // street_number or no postal_code component used to be refused outright
    // below, which left City, State and ZIP blank on the form.
    const details: AddressDetails = addressFromPlace({
      addressComponents: json.addressComponents,
      formattedAddress: json.formattedAddress,
      location: json.location,
      suggestion: opts?.suggestion,
    });
    // All or nothing (#783): a match that cannot supply every part of the
    // address is not a match. Returning it would leave the form to take the
    // missing part from what was typed — a suggestion's street over a typed
    // ZIP is exactly the saved address QA found.
    if (!isCompletePick(details)) return null;
    return details;
  },
};
